import { certifyLifecycleEvidence } from './lifecycleCertificationEngine.mjs';
import { buildLifecycleCertificationArtifact } from './lifecycleCertificationProvenance.mjs';
const rowsToMap=(rows,key)=>Object.fromEntries(rows.map(row=>[String(row[key]),Number(row.count)||0]));
const scalar=(rows,key)=>Number(rows?.[0]?.[key])||0;

export async function buildLifecycleEvidenceSnapshot(sql,{deployedCommitSha="",releaseId=""}={}){
  const [telemetry,leads,actions,orders,financial,lifecycle,customers,touchpoints,economics,evidence]=await Promise.all([
    sql.query("select event_name,count(*)::int count from telemetry_events group by event_name"),
    sql.query("select stage,count(*)::int count from sales_leads group by stage"),
    sql.query("select action_type,status,count(*)::int count from sales_actions group by action_type,status"),
    sql.query("select status,count(*)::int count from orders group by status"),
    sql.query("select normalized_event,count(*)::int count from financial_events group by normalized_event"),
    sql.query("select event_type,count(*)::int count from customer_lifecycle_events group by event_type"),
    sql.query("select count(*)::int count from customer_lifecycle_profiles"),
    sql.query("select count(*)::int count from attribution_touchpoints"),
    sql.query("select count(*)::int count,count(distinct date_trunc('month',period_end))::int months,coalesce(max(case when (gross_revenue_brl-refunds_brl-payment_fees_brl-variable_costs_brl-acquisition_spend_brl)>0 then paid_orders else 0 end),0)::int profitable_paid_orders from unit_economics_snapshots"),
    sql.query("select dimension,count(*)::int count,array_agg(evidence_sha256 order by evidence_sha256) evidence_hashes from lifecycle_evidence_events where proof_kind='observed_production' and verification_status='verified' and source_class in ('canonical_database','provider_webhook','operator_validation') group by dimension"),
  ]);
  const leadMap=rowsToMap(leads,'stage');
  const orderMap=rowsToMap(orders,'status');
  const actionCompleted=Object.fromEntries(actions.filter(x=>x.status==='completed').map(x=>[String(x.action_type),Number(x.count)||0]));
  const lifecycleMap=rowsToMap(lifecycle,'event_type');
  const financialMap=rowsToMap(financial,'normalized_event');
  const directEvidence=rowsToMap(evidence,'dimension');
  const paidOrders=orderMap.paid||0;
  const observed={
    page_views:telemetry.filter(x=>x.event_name==='page_view').reduce((a,x)=>a+Number(x.count||0),0),
    leads:Object.values(leadMap).reduce((a,b)=>a+Number(b||0),0),
    identified_leads:directEvidence.identity||0,enriched_leads:directEvidence.enrichment||0,scored_leads:directEvidence.scoring||0,prioritized_leads:directEvidence.prioritization||0,
    contacted_leads:Math.max(leadMap.contacted||0,directEvidence.first_response||0),qualified_leads:Math.max(leadMap.qualified||0,directEvidence.qualification||0),
    discovery_completed:directEvidence.discovery||0,nurture_actions:Math.max(actionCompleted.follow_up||0,directEvidence.nurturing||0),
    objections_handled:directEvidence.objection||0,offer_sent:Math.max(leadMap.offer_sent||0,directEvidence.offer||0),
    negotiations:directEvidence.negotiation||0,checkout_started:Math.max(leadMap.checkout_started||0,directEvidence.checkout||0),
    abandonment_recoveries:directEvidence.abandonment_recovery||0,paid_orders:paidOrders,
    reconciled_payments:Math.max(financialMap.payment_confirmed||0,directEvidence.reconciliation||0),
    delivered_orders:Math.max(orderMap.delivered||0,directEvidence.fulfillment||0),lifecycle_events:lifecycleMap,customers:scalar(customers,'count'),
    attribution_touchpoints:scalar(touchpoints,'count'),economics_snapshots:scalar(economics,'count'),
    monthly_revenue_periods:scalar(economics,'months'),experiment_outcomes:directEvidence.experiment||0,
    learning_cycles:directEvidence.learning||0,next_best_actions_executed:directEvidence.next_best_action||0,
    profitable_paid_orders:scalar(economics,'profitable_paid_orders'),verified_evidence:directEvidence,
  };
  const certification=certifyLifecycleEvidence(observed);
  const evidenceHashes=evidence.flatMap(row=>Array.isArray(row.evidence_hashes)?row.evidence_hashes:[]).filter(Boolean);
  const provenance=buildLifecycleCertificationArtifact({certification,evidenceHashes,evidenceFacts:observed,deployedCommitSha,releaseId});
  return Object.freeze({commercial_unlock:false,artifact_eligible:certification.approved===true,provenance,certification,evidence_summary:Object.freeze({
    paid_orders:paidOrders,total_leads:observed.leads,page_views:observed.page_views,
    lifecycle_events:Object.values(lifecycleMap).reduce((a,b)=>a+Number(b||0),0),
    attribution_touchpoints:observed.attribution_touchpoints,economics_snapshots:observed.economics_snapshots,
  })});
}

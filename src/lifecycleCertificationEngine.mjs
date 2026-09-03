import { SALES_LIFECYCLE_CANONICAL_V2, SALES_LIFECYCLE_LABELS } from './salesLifecycleV2.mjs';
import { assessLifecycleCapabilityCoverage } from './salesLifecycleCapabilities.mjs';

const n=(v)=>Math.max(0,Number(v)||0);
const has=(obj,key)=>n(obj?.[key])>0;
const sum=(obj,keys)=>keys.reduce((total,key)=>total+n(obj?.[key]),0);

export const LIFECYCLE_PROOF_POLICY=Object.freeze({
  market:e=>n(e.paid_orders)>=5,
  icp:e=>n(e.qualified_leads)>=5&&n(e.paid_orders)>=3,
  acquisition:e=>n(e.page_views)>=100&&n(e.leads)>=5,
  capture:e=>n(e.leads)>=5,
  identity:e=>n(e.identified_leads)>=5,
  enrichment:e=>n(e.enriched_leads)>=5,
  scoring:e=>n(e.scored_leads)>=5,
  prioritization:e=>n(e.prioritized_leads)>=5,
  first_response:e=>n(e.contacted_leads)>=5,
  discovery:e=>n(e.discovery_completed)>=1,
  qualification:e=>n(e.qualified_leads)>=5,
  nurturing:e=>n(e.nurture_actions)>=1,
  objection:e=>n(e.objections_handled)>=1,
  offer:e=>n(e.offer_sent)>=5,
  negotiation:e=>n(e.negotiations)>=1,
  checkout:e=>n(e.checkout_started)>=3,
  abandonment_recovery:e=>n(e.abandonment_recoveries)>=1,
  payment:e=>n(e.paid_orders)>=3,
  reconciliation:e=>n(e.reconciled_payments)>=3,
  fulfillment:e=>n(e.delivered_orders)>=3,
  onboarding:e=>has(e.lifecycle_events,'onboarding_completed'),
  support:e=>sum(e.lifecycle_events,['support_opened','support_resolved'])>=1,
  adoption:e=>has(e.lifecycle_events,'adoption_updated'),
  satisfaction:e=>has(e.lifecycle_events,'satisfaction_recorded'),
  retention:e=>has(e.lifecycle_events,'retention_intervention'),
  repurchase:e=>has(e.lifecycle_events,'repurchase'),
  upsell:e=>has(e.lifecycle_events,'upsell'),
  cross_sell:e=>has(e.lifecycle_events,'cross_sell'),
  referral:e=>has(e.lifecycle_events,'referral'),
  win_back:e=>has(e.lifecycle_events,'win_back'),
  churn:e=>has(e.lifecycle_events,'churn'),
  ltv:e=>n(e.paid_orders)>=10&&n(e.customers)>=5,
  attribution:e=>n(e.attribution_touchpoints)>=10&&n(e.paid_orders)>=3,
  unit_economics:e=>n(e.economics_snapshots)>=3&&n(e.paid_orders)>=3,
  experiment:e=>n(e.experiment_outcomes)>=1,
  learning:e=>n(e.learning_cycles)>=1&&n(e.paid_orders)>=1,
  forecast:e=>n(e.monthly_revenue_periods)>=6,
  next_best_action:e=>n(e.next_best_actions_executed)>=1,
  scale:e=>n(e.paid_orders)>=10&&n(e.profitable_paid_orders)>=10,
});
export function certifyLifecycleEvidence(evidence={}){
  const coverage=assessLifecycleCapabilityCoverage();
  const dimensions=SALES_LIFECYCLE_CANONICAL_V2.map((key)=>{
    const technical_ready=coverage.complete===true;
    const directObserved=n(evidence?.verified_evidence?.[key])>=3;
    const production_proven=technical_ready&&Boolean(LIFECYCLE_PROOF_POLICY[key]?.(evidence)||directObserved);
    return Object.freeze({
      key,label:SALES_LIFECYCLE_LABELS[key],technical_ready,production_proven,
      score:production_proven?10:(technical_ready?9:0),
      pass:production_proven,
      blocker:production_proven?null:`lifecycle_real_evidence_missing:${key}`,
    });
  });
  const blockers=dimensions.filter(x=>!x.pass).map(x=>x.blocker);
  return Object.freeze({
    version:'sales-lifecycle-canonical-v2-evidence',
    rule:'10_only_with_technical_readiness_and_observed_production_evidence',
    approved:blockers.length===0,required_score:10,total_dimensions:dimensions.length,
    technical_ready_dimensions:dimensions.filter(x=>x.technical_ready).length,
    proven_dimensions:dimensions.filter(x=>x.production_proven).length,
    dimensions:Object.freeze(dimensions),blockers:Object.freeze(blockers),
  });
}

import {buildCustomerFeatures,segmentCustomer} from './customerDataPlaneV2.mjs';
import {chooseContextualDecision} from './decisionEngineV2.mjs';
import {routeCommercialTask} from './multiAgentOrchestrator.mjs';
import {nextJourneyStep} from './journeyOrchestratorV2.mjs';
import {tenantDataEnvelope,validTenantId} from './tenantIsolation.mjs';

const jobKind=Object.freeze({lead_review:'lead',follow_up_plan:'follow_up',offer_review:'offer',learning_review:'learning',knowledge_refresh:'market',customer_lifecycle_review:'retention',attribution_review:'attribution'});
export function buildCommercialEngineContext({job={},lead=null,customer=null,outcome_learning=null}={}){
  const requested=String(job?.payload?.tenant_id||'zevanory'); const tenant_id=validTenantId(requested)?requested:'zevanory';
  const features=buildCustomerFeatures({purchases:customer?.purchase_count,days_since_last_activity:job?.payload?.days_since_last_activity,engagement_score:job?.payload?.engagement_score,net_revenue_brl:job?.payload?.net_revenue_brl});
  const segment=segmentCustomer(features); const kind=jobKind[job.job_type]||String(job?.payload?.kind||'');
  const specialist=routeCommercialTask({kind});
  const journey=nextJourneyStep({stage:lead?.stage,consent_allowed:job?.payload?.consent_allowed===true,suppressed:job?.payload?.suppressed===true,touches_24h:job?.payload?.touches_24h,touches_7d:job?.payload?.touches_7d,minutes_since_last_touch:job?.payload?.minutes_since_last_touch,preferred_channel:lead?.channel});
  const decision=chooseContextualDecision({candidates:job?.payload?.decision_candidates||[],context:{channel_fit:job?.payload?.channel_fit},operation_key:job.idempotency_key||job.job_id||''});
  return Object.freeze({version:'commercial-engine-v2',tenant:tenantDataEnvelope(tenant_id,{scope:'revenue-agent'}),customer:Object.freeze({features,segment}),specialist,journey,decision,outcome_learning:outcome_learning||null,commercial_unlock:false});
}

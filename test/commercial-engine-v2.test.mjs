import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalIdentityKey,consentState,buildCustomerFeatures,segmentCustomer} from '../src/customerDataPlaneV2.mjs';
import {chooseContextualDecision} from '../src/decisionEngineV2.mjs';
import {buildSupervisorPlan,authorizeSpecialistTool} from '../src/multiAgentOrchestrator.mjs';
import {journeyEligibility,nextJourneyStep} from '../src/journeyOrchestratorV2.mjs';
import {authorizeTenantAction,tenantScopedKey} from '../src/tenantIsolation.mjs';
import {buildCommercialEngineContext} from '../src/commercialEngineV2.mjs';

test('customer data plane unifies identity consent features and segment',()=>{
  assert.equal(canonicalIdentityKey({email:'A@B.COM'}),canonicalIdentityKey({email:'a@b.com'}));
  assert.equal(consentState([{purpose:'marketing',status:'granted',occurred_at:'2026-01-01'}]).marketing.status,'granted');
  const f=buildCustomerFeatures({purchases:8,net_revenue_brl:1800,days_since_last_activity:2,engagement_score:.9});
  assert.equal(segmentCustomer(f),'champion');
});
test('decision engine requires causal evidence and never unlocks commerce',()=>{
  const weak=chooseContextualDecision({operation_key:'x',candidates:[{id:'a',propensity:.9,uplift:0,confidence:.9}]});
  assert.equal(weak.ready,false);
  const strong=chooseContextualDecision({operation_key:'stable',candidates:[{id:'a',propensity:.9,uplift:.08,confidence:.9,margin_score:.8,context_fit:.9}]});
  assert.equal(strong.commercial_unlock,false); assert.equal(strong.ready,true);
});
test('multi-agent supervisor routes every specialist and preserves gates',()=>{
  const plan=buildSupervisorPlan([{kind:'market'},{kind:'creative'},{kind:'lead'},{kind:'support'},{kind:'reconciliation'},{kind:'learning'}]);
  assert.equal(plan.ready,true); assert.equal(new Set(plan.steps.map(x=>x.route.agent)).size,6);
  assert.equal(authorizeSpecialistTool('send_message',{}).allowed,false);
});
test('journey orchestration enforces consent suppression frequency and gate',()=>{
  assert.equal(journeyEligibility({stage:'contacted',consent_allowed:false}).eligible,false);
  assert.equal(journeyEligibility({stage:'contacted',consent_allowed:true,suppressed:false,touches_24h:2}).eligible,false);
  const step=nextJourneyStep({stage:'qualified',consent_allowed:true,suppressed:false,touches_24h:0,touches_7d:1,minutes_since_last_touch:500,preferred_channel:'email'});
  assert.equal(step.action,'offer_follow_up'); assert.equal(step.requires_sales_gate,true);
});
test('tenant isolation rejects cross-tenant access and namespaces keys',()=>{
  assert.equal(authorizeTenantAction({tenant_id:'tenant-a',actor_tenant_id:'tenant-b',role:'owner',action:'commercial'}).allowed,false);
  assert.equal(authorizeTenantAction({tenant_id:'tenant-a',actor_tenant_id:'tenant-a',role:'admin',action:'commercial'}).allowed,true);
  assert.notEqual(tenantScopedKey('tenant-a','lead-1'),tenantScopedKey('tenant-b','lead-1'));
});
test('commercial engine v2 facade composes all five evolutions without unlocking sales',()=>{
  const ctx=buildCommercialEngineContext({job:{job_type:'lead_review',idempotency_key:'op-1',payload:{consent_allowed:true,minutes_since_last_touch:500}},lead:{stage:'new',channel:'whatsapp'},customer:{purchase_count:1}});
  assert.equal(ctx.version,'commercial-engine-v2');
  assert.equal(ctx.tenant.tenant_id,'zevanory');
  assert.equal(ctx.specialist.agent,'sales');
  assert.equal(ctx.journey.action,'first_response');
  assert.equal(ctx.commercial_unlock,false);
});

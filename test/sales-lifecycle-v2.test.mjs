import test from 'node:test';
import assert from 'node:assert/strict';
import { SALES_LIFECYCLE_CANONICAL_V2, evaluateLifecycleCertification, salesLifecycleGate } from '../src/salesLifecycleV2.mjs';
import { salesGate } from '../src/salesGate.mjs';
import { authorizeTool } from '../src/agentPolicy.mjs';
import { customerHealth,nextCustomerAction,churnState } from '../src/customerLifecycleEngine.mjs';
import { revenueIntelligence,forecastRevenue,nextBestRevenueAction } from '../src/revenueIntelligence.mjs';
import { attributeRevenue } from '../src/attributionEngine.mjs';

const perfect=()=>({
  version:'sales-lifecycle-canonical-v2',
  scores:Object.fromEntries(SALES_LIFECYCLE_CANONICAL_V2.map(key=>[key,10])),
  audit_10x_pass:true,production_parity_verified:true,release_approved:true,
});

test('canonical v2 contains all 39 sales lifecycle dimensions in fixed order',()=>{
  assert.equal(SALES_LIFECYCLE_CANONICAL_V2.length,39);
  assert.deepEqual(SALES_LIFECYCLE_CANONICAL_V2.slice(0,5),['market','icp','acquisition','capture','identity']);
  assert.deepEqual(SALES_LIFECYCLE_CANONICAL_V2.slice(-5),['experiment','learning','forecast','next_best_action','scale']);
});
test('every dimension must score exactly 10',()=>{
  const cert=perfect(); cert.scores.retention=9;
  const result=evaluateLifecycleCertification(cert);
  assert.equal(result.approved,false);
  assert.ok(result.blockers.includes('lifecycle_score_below_10:retention'));
});

test('perfect scores still require audit parity and release approval',()=>{
  const cert=perfect(); cert.audit_10x_pass=false;
  assert.equal(evaluateLifecycleCertification(cert).approved,false);
  cert.audit_10x_pass=true; cert.production_parity_verified=false;
  assert.equal(evaluateLifecycleCertification(cert).approved,false);
  cert.production_parity_verified=true; cert.release_approved=false;
  assert.equal(evaluateLifecycleCertification(cert).approved,false);
  cert.release_approved=true;
  assert.equal(evaluateLifecycleCertification(cert).approved,true);
});

test('current lifecycle certification is intentionally fail closed',()=>{
  const result=salesLifecycleGate();
  assert.equal(result.approved,false);
  assert.equal(result.passed_dimensions,0);
});
test('environment switches cannot bypass lifecycle certification',()=>{
  const env={SALE_GLOBALLY_ENABLED:'true',PRE_SALE_GATES_APPROVED:'true'};
  const gate=salesGate(env);
  assert.equal(gate.enabled,false);
  assert.equal(gate.lifecycle_approved,false);
  assert.ok(gate.blockers.some(x=>x.startsWith('lifecycle_score_below_10:')));
  assert.equal(authorizeTool('send_message',env).allowed,false);
  assert.equal(authorizeTool('start_checkout',{...env,CHECKOUT_ENABLED:'true',FINANCIAL_EVENTS_ENABLED:'true'}).allowed,false);
});

test('customer lifecycle prioritizes onboarding support retention and expansion safely',()=>{
  assert.equal(nextCustomerAction({delivered:true,onboarding_complete:false}).action,'complete_onboarding');
  assert.equal(nextCustomerAction({delivered:true,onboarding_complete:true,open_support_tickets:1}).action,'resolve_support');
  const health=customerHealth({adoption_score:1,satisfaction_score:1,support_risk:0,last_activity_at:new Date().toISOString()});
  assert.ok(health.score>0.9);
  assert.equal(churnState({cancelled:true}).churned,true);
});

test('revenue intelligence never invents forecast without sufficient baseline',()=>{
  const metrics=revenueIntelligence({customers:10,paid_orders:12,repeat_orders:2,retained_customers:8,churned_customers:2,gross_revenue_brl:1200});
  assert.equal(metrics.retention_rate,0.8);
  assert.equal(forecastRevenue({monthly_net_revenue_brl:[100,120]}).available,false);
  assert.ok(nextBestRevenueAction({customers:0}).action.length>0);
});
test('multi-touch attribution conserves one hundred percent of revenue credit',()=>{
  const result=attributeRevenue({revenue_brl:100,touchpoints:[{channel:'instagram'},{channel:'whatsapp'},{channel:'email'}],model:'linear'});
  const credit=result.touchpoints.reduce((sum,x)=>sum+x.credit,0);
  const revenue=Object.values(result.by_channel).reduce((sum,x)=>sum+x,0);
  assert.ok(Math.abs(credit-1)<1e-9);
  assert.ok(Math.abs(revenue-100)<1e-9);
});

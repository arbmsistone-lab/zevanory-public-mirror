import test from 'node:test';
import assert from 'node:assert/strict';
import { identityReadiness,enrichmentReadiness,scoreIcpFit,scoreLead,prioritizeLead,discoveryGaps,qualificationDecision } from '../src/leadIntelligence.mjs';
import { buildDiscoveryPlan,nurturingPlan,objectionResponsePolicy,negotiationDecision,abandonmentRecoveryPlan } from '../src/conversationLifecycle.mjs';

test('identity and enrichment require explicit verified evidence',()=>{
  assert.equal(identityReadiness({contact_ref:'x',channel:'whatsapp'}).ready,false);
  assert.equal(identityReadiness({contact_ref:'x',channel:'whatsapp',consent_basis:'inbound'}).ready,true);
  assert.equal(enrichmentReadiness({facts:{company:{value:'A',verified:false}}}).ready,false);
  assert.equal(enrichmentReadiness({facts:{company:{value:'A',verified:true}}}).ready,true);
});

test('ICP scoring and lead priority degrade safely with missing evidence',()=>{
  const partial=scoreIcpFit({segment_fit:1}); assert.equal(partial.complete,false); assert.equal(partial.confidence,0.3);
  const lead=scoreLead({icp_score:1,intent_score:0.8,engagement_score:0.8,recency_score:1});
  assert.ok(lead.score>0.8); assert.equal(lead.complete,true);
  const priority=prioritizeLead({...lead,icp_score:1,intent_score:0.8,engagement_score:0.8,recency_score:1,urgency_score:1,response_delay_risk:1});
  assert.equal(priority.priority,'p1');
});
test('discovery and qualification never infer missing commercial facts',()=>{
  const gaps=discoveryGaps({problem:'manual',desired_outcome:'automatizar'});
  assert.equal(gaps.complete,false); assert.ok(gaps.missing.includes('budget_context'));
  const plan=buildDiscoveryPlan({problem:'manual'}); assert.equal(plan.complete,false); assert.equal(plan.next_question.key,'desired_outcome');
  const q=qualificationDecision({problem:'p',desired_outcome:'o',decision_process:'d',timeline:'t',budget_context:'b',current_process:'c',problem_confirmed:true,next_step_consent:true,icp:{segment_fit:1,problem_fit:1,digital_sales_fit:1,operational_pain:1}});
  assert.equal(q.qualified,true);
});

test('nurturing and abandonment recovery are bounded and honor opt-out',()=>{
  assert.equal(nurturingPlan({opted_out:true}).action,'stop');
  assert.equal(nurturingPlan({touchpoints:8}).action,'recycle');
  assert.equal(abandonmentRecoveryPlan({opted_out:true}).action,'stop');
  assert.equal(abandonmentRecoveryPlan({attempts:3}).reason,'recovery_touchpoint_ceiling');
});

test('objection policy requires evidence and negotiation enforces price floor',()=>{
  assert.equal(objectionResponsePolicy({category:'trust',evidence_available:false}).action,'collect_evidence');
  assert.equal(objectionResponsePolicy({category:'unknown'}).action,'review');
  assert.equal(negotiationDecision({list_price_brl:100,proposed_price_brl:70,min_price_brl:80}).allowed,false);
  assert.equal(negotiationDecision({list_price_brl:100,proposed_price_brl:85,min_price_brl:80}).allowed,true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {AUTONOMY_POLICY,assessAutonomy} from '../src/autonomyPolicy.mjs';
import {requiresHumanApproval} from '../src/agentControl.mjs';

const healthy={runs_24h:100,failed_24h:0,eval_total_24h:100,eval_passed_24h:100,dead_letter_24h:0,retry_24h:0};
const learning={confidence:.9,total_matured:100,winner:{channel:'whatsapp'}};
const env={AGENT_AUTONOMY_MODE:'progressive',AGENT_HUMAN_APPROVAL_REQUIRED:'false',SALE_GLOBALLY_ENABLED:'true',PRE_SALE_GATES_APPROVED:'true',CHECKOUT_ENABLED:'true',FINANCIAL_EVENTS_ENABLED:'true',PAYMENT_MERCHANT_IDENTITY_VERIFIED:'true'};
const evalResult={pass:true,score:1};

test('sensitive tools still enter approval path before progressive bypass',()=>{
  assert.equal(requiresHumanApproval('send_message','commercial',{AGENT_HUMAN_APPROVAL_REQUIRED:'false'}),true);
  assert.equal(requiresHumanApproval('start_checkout','financial',{AGENT_HUMAN_APPROVAL_REQUIRED:'false'}),true);
});

test('guarded mode blocks commercial autonomy even with otherwise healthy evidence',()=>{
  const result=assessAutonomy({tool:'send_message',riskLevel:'commercial',env:{...env,AGENT_AUTONOMY_MODE:'guarded'},evalResult,context:{lead:{channel:'whatsapp'},outcome_learning:learning},health:healthy});
  assert.equal(result.eligible,false);assert.equal(result.reason,'guarded_mode');
});

test('refund is never autonomous in v1',()=>{
  const result=assessAutonomy({tool:'refund_payment',riskLevel:'financial',env,evalResult,context:{lead:{channel:'whatsapp'},outcome_learning:learning},health:healthy});
  assert.equal(result.eligible,false);assert.equal(result.reason,'never_autonomous_tool');
});
test('commercial autonomy requires learned winning channel and healthy runtime',()=>{
  const mismatch=assessAutonomy({tool:'send_message',riskLevel:'commercial',env,evalResult,context:{lead:{channel:'email'},outcome_learning:learning},health:healthy});
  assert.equal(mismatch.eligible,false);assert.equal(mismatch.reason,'learning_channel_mismatch');
  const ready=assessAutonomy({tool:'send_message',riskLevel:'commercial',env,evalResult,context:{lead:{channel:'whatsapp'},outcome_learning:learning},health:healthy});
  assert.equal(ready.eligible,true);assert.equal(ready.reason,'progressive_thresholds_met');
});

test('runtime regressions revoke autonomy immediately',()=>{
  const retry=assessAutonomy({tool:'send_message',riskLevel:'commercial',env,evalResult,context:{lead:{channel:'whatsapp'},outcome_learning:learning},health:{...healthy,retry_24h:1}});
  assert.equal(retry.eligible,false);assert.equal(retry.reason,'integration_health_not_clean');
  const lowCoverage=assessAutonomy({tool:'send_message',riskLevel:'commercial',env,evalResult,context:{lead:{channel:'whatsapp'},outcome_learning:learning},health:{...healthy,eval_total_24h:90,eval_passed_24h:90}});
  assert.equal(lowCoverage.eligible,false);assert.equal(lowCoverage.reason,'runtime_eval_coverage_insufficient');
});

test('checkout may be autonomous only with explicit financial preconditions',()=>{
  const blocked=assessAutonomy({tool:'start_checkout',riskLevel:'financial',env:{...env,PAYMENT_MERCHANT_IDENTITY_VERIFIED:'false'},evalResult,context:{lead:{channel:'whatsapp'},outcome_learning:learning},health:healthy});
  assert.equal(blocked.eligible,false);assert.equal(blocked.reason,'financial_preconditions_closed');
  const ready=assessAutonomy({tool:'start_checkout',riskLevel:'financial',env,evalResult,context:{lead:{channel:'whatsapp'},outcome_learning:learning},health:healthy});
  assert.equal(ready.eligible,true);
  assert.ok(AUTONOMY_POLICY.min_eval_pass_rate>=.99&&AUTONOMY_POLICY.max_failed_run_ratio<=.01);
});

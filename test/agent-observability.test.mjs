import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAgentObservability,deriveExecutionState} from '../src/agentObservability.mjs';

test('external tool completion is not confused with business truth',()=>{
  const run={run_id:'r1',tool:'publish_content',outcome:'completed',result:{event_id:'e1'},trace_id:'t1',span_id:'s1',latency_ms:120};
  assert.equal(deriveExecutionState(run,null),'external_request_unobserved');
  assert.equal(deriveExecutionState(run,{status:'pending'}),'external_request_pending');
  assert.equal(deriveExecutionState(run,{status:'delivered'}),'external_request_accepted');
  assert.equal(deriveExecutionState(run,{status:'delivered',provider_confirmation:{outcome:'confirmed'}}),'external_effect_confirmed');
  assert.equal(deriveExecutionState(run,{status:'delivered',provider_confirmation:{outcome:'failed'}}),'external_effect_failed');
});

test('observability reports trace coverage latency approvals and external state',()=>{
  const data=buildAgentObservability({
    runs:[
      {run_id:'r1',tool:'publish_content',outcome:'completed',trace_id:'t1',span_id:'s1',latency_ms:100,eval:{pass:true}},
      {run_id:'r2',tool:'remember_fact',outcome:'completed',trace_id:'t2',span_id:'s2',latency_ms:300,eval:{pass:true}},
      {run_id:'r3',tool:'send_message',outcome:'blocked',result:{state:'awaiting_approval'},latency_ms:900,eval:{pass:false}},
    ],
    outbox:[{run_id:'r1',status:'delivered'}],approvals:[{status:'pending'}],
  });
  assert.equal(data.metrics.total_runs,3);
  assert.equal(data.metrics.trace_coverage,2/3);
  assert.equal(data.metrics.pending_approvals,1);
  assert.equal(data.metrics.external_requests_accepted,1);
  assert.equal(data.metrics.external_effects_confirmed,0);
  assert.equal(data.metrics.eval_coverage,1);
  assert.equal(data.metrics.eval_pass_rate,2/3);
  assert.equal(data.metrics.latency_p50_ms,300);
  assert.equal(data.metrics.latency_p95_ms,900);
  assert.equal(data.metrics.business_truth_mode,'provider_reconciliation_required');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {OUTCOME_LEARNING_POLICY,summarizeOutcomeArms,chooseLearnedArm,wilsonLowerBound,loadOutcomeLearningMemory,queueOutcomeLearningReview} from '../src/outcomeLearning.mjs';

test('Wilson lower bound is conservative and monotonic enough for gating',()=>{
  assert.equal(wilsonLowerBound(0,0),0);
  assert.ok(wilsonLowerBound(20,100)<0.20);
  assert.ok(wilsonLowerBound(40,100)>wilsonLowerBound(20,100));
});

test('learning remains blocked below real outcome thresholds',()=>{
  const arms=summarizeOutcomeArms([{experiment_id:'e',offer_id:'o',channel:'instagram',sessions:100,qualified:20,checkout:10,paid:2,refunded:0,gross_revenue_brl:994}]);
  const result=chooseLearnedArm(arms);
  assert.equal(result.ready,false);assert.equal(result.reason,'insufficient_total_matured');
});

test('learning ranks eligible arms using conservative paid signal and refunds',()=>{
  const arms=summarizeOutcomeArms([
    {experiment_id:'e',offer_id:'o',channel:'instagram',sessions:200,qualified:40,checkout:34,paid:28,refunded:2,gross_revenue_brl:13916},
    {experiment_id:'e',offer_id:'o',channel:'whatsapp',sessions:200,qualified:50,checkout:44,paid:36,refunded:1,gross_revenue_brl:17892},
  ]);
  const result=chooseLearnedArm(arms,{...OUTCOME_LEARNING_POLICY,min_total_matured:40,min_matured_per_arm:20,min_paid_per_arm:3});
  assert.equal(result.ready,true);assert.equal(result.winner.channel,'whatsapp');assert.equal(result.exploration_rate,OUTCOME_LEARNING_POLICY.exploration_rate_cap);
});
test('only ready non-expired outcome memory enters agent context',async()=>{
  const sqlReady={query:async()=>[{memory_value:{policy_version:'v1',decision:{ready:true,winner:{channel:'email'},exploration_rate:0,total_matured:40}},confidence:.8,updated_at:'2026-09-01T00:00:00Z'}]};
  const ready=await loadOutcomeLearningMemory(sqlReady);assert.equal(ready.winner.channel,'email');assert.equal(ready.confidence,.8);
  const sqlBlocked={query:async()=>[{memory_value:{decision:{ready:false}},confidence:0}]};
  assert.equal(await loadOutcomeLearningMemory(sqlBlocked),null);
});

test('financial outcomes queue idempotent learning review jobs',async()=>{
  const calls=[];const sql={query:async(q,args)=>{calls.push({q,args});return [{job_id:'11111111-1111-4111-8111-111111111111'}];}};
  const result=await queueOutcomeLearningReview(sql,{idempotencyKey:'learning:financial:event-1',source:'financial:payment_confirmed'});
  assert.equal(result.queued,true);assert.match(calls[0].q,/learning_review/);assert.match(calls[0].q,/on conflict\(idempotency_key\) do nothing/);
});

test('learning policy stays bounded and evidence-driven',()=>{
  assert.ok(OUTCOME_LEARNING_POLICY.min_total_matured>=30);
  assert.ok(OUTCOME_LEARNING_POLICY.min_matured_per_arm>=20);
  assert.ok(OUTCOME_LEARNING_POLICY.exploration_rate_cap<=0.10);
  assert.ok(OUTCOME_LEARNING_POLICY.window_days<=90);
});

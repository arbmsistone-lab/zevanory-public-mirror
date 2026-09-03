import test from 'node:test';
import assert from 'node:assert/strict';
import { nbaExecutionConfirmed, recordNextBestActionEvidence } from '../src/agentWorker.mjs';

test('NBA proof requires an actually applied executable action',()=>{
  assert.equal(nbaExecutionConfirmed('schedule_follow_up',{scheduled:true}),true);
  assert.equal(nbaExecutionConfirmed('schedule_follow_up',{scheduled:false}),false);
  assert.equal(nbaExecutionConfirmed('send_message',{event_id:'e1',status:'pending'}),true);
  assert.equal(nbaExecutionConfirmed('start_checkout',{event_id:'e2',status:'delivered'}),true);
  assert.equal(nbaExecutionConfirmed('create_offer_draft',{draft_only:true}),false);
  assert.equal(nbaExecutionConfirmed('get_command_center',{observed:true}),false);
});

test('NBA proof refuses missing real lead or observed outcome learning',async()=>{
  const sql={query:async()=>{throw new Error('must_not_write')}};
  assert.equal(await recordNextBestActionEvidence(sql,{runId:'r1',context:{lead:null,outcome_learning:{total_matured:60}},tool:'schedule_follow_up',result:{scheduled:true},decision:{action:'follow_up'}}),null);
  assert.equal(await recordNextBestActionEvidence(sql,{runId:'r2',context:{lead:{lead_id:'lead-1'},outcome_learning:null},tool:'schedule_follow_up',result:{scheduled:true},decision:{action:'follow_up'}}),null);
});

test('NBA proof persists trusted canonical evidence for a real learned action',async()=>{
  let call=null;
  const sql={query:async(text,args)=>{call={text,args};return [{evidence_id:'ev1',dimension:'next_best_action',source_class:'canonical_database',verification_status:'verified',evidence_sha256:'a'.repeat(64),occurred_at:new Date().toISOString()}];}};
  const result=await recordNextBestActionEvidence(sql,{runId:'run-real-1',context:{lead:{lead_id:'lead-real-1'},outcome_learning:{policy_version:'outcome-policy-v1',total_matured:60,winner:{key:'exp|offer|instagram'}}},tool:'send_message',result:{event_id:'outbox-1',status:'pending'},decision:{action:'send_message'}});
  assert.equal(result.inserted,true);
  assert.match(call.text,/insert into lifecycle_evidence_events/);
  assert.equal(call.args[1],'next_best_action');
  assert.equal(call.args[2],'revenue_agent');
  assert.equal(call.args[3],'lead-real-1');
  assert.match(call.args[4],/^next-best-action:run-real-1$/);
});

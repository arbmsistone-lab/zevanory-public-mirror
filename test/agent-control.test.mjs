import test from 'node:test';
import assert from 'node:assert/strict';
import {requiresHumanApproval,getAgentControlState,setAgentPaused,decideApproval} from '../src/agentControl.mjs';

test('high-risk tools require human approval by default',()=>{
  for(const tool of ['send_message','publish_content','start_checkout','refund_payment']) assert.equal(requiresHumanApproval(tool,tool.includes('checkout')||tool.includes('refund')?'financial':'commercial',{}),true);
  assert.equal(requiresHumanApproval('remember_fact','write',{}),false);
});

test('missing control state fails closed as paused',async()=>{
  const sql={query:async()=>[]}; const state=await getAgentControlState(sql); assert.equal(state.paused,true); assert.equal(state.reason,'control_state_missing');
});

test('pause writes the singleton control state',async()=>{
  let args; const sql={query:async(_q,a)=>{args=a;return [{paused:a[0],reason:a[1],changed_by:a[2]}]}};
  const state=await setAgentPaused(sql,{paused:true,reason:'incident',operator:'tester'});assert.equal(state.paused,true);assert.deepEqual(args,[true,'incident','tester']);
});

test('approved action requeues a previously blocked job',async()=>{
  const calls=[];const sql={query:async(q,a)=>{calls.push(String(q));if(String(q).includes('update agent_approvals'))return [{approval_id:a[0],job_id:'11111111-1111-4111-8111-111111111111',tool_name:'publish_content',status:a[1]}];return []}};
  const result=await decideApproval(sql,{approvalId:'22222222-2222-4222-8222-222222222222',decision:'approved',reason:'reviewed',operator:'tester'});assert.equal(result.status,'approved');assert.equal(calls.some(q=>q.includes("update agent_jobs set status='queued'")),true);
});

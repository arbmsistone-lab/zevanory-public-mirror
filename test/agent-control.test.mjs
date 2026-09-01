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

test('pause persists control in existing agent memory',async()=>{
  let args; const sql={query:async(_q,a)=>{args=a;return [{memory_value:JSON.parse(a[3]),updated_at:'2026-09-01T00:00:00Z'}]}};
  const state=await setAgentPaused(sql,{paused:true,reason:'incident',operator:'tester'});assert.equal(state.paused,true);assert.equal(args[1],'zevanory_robot');assert.equal(args[2],'control');assert.match(args[3],/"paused":true/);
});

test('approved action requeues job through payload approval state',async()=>{
  const approval={approval_id:'22222222-2222-4222-8222-222222222222',job_id:'11111111-1111-4111-8111-111111111111',tool_name:'publish_content',status:'approved'};
  const sql={query:async(q)=>String(q).includes('update agent_jobs set')?[{job_id:approval.job_id,approval}]:[]};
  const result=await decideApproval(sql,{approvalId:approval.approval_id,decision:'approved',reason:'reviewed',operator:'tester'});assert.equal(result.status,'approved');assert.equal(result.job_id,approval.job_id);
});

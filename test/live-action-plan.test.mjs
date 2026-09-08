import test from 'node:test';
import assert from 'node:assert/strict';
import {buildLiveActionPlan,persistLiveActionPlan,transitionLiveActionPlan,summarizeLiveActionPlan} from '../src/liveActionPlan.mjs';

const job={job_id:'11111111-1111-4111-8111-111111111111',job_type:'offer_review',payload:{}};
const context={lead:{channel:'instagram',contact_ref:'SECRET_CONTACT',session_id:'SECRET_SESSION'}};
const decision={action:'publish_content',rationale:'Publicar conteúdo aprovado para awareness.',content:'Texto público de teste.',expected_result:'Provedor aceitar a publicação.'};
const auth={allowed:true,risk_level:'commercial',reason:'commercial_gates_open'};

test('manifest contains every required operator field before execution without PII',()=>{
  const plan=buildLiveActionPlan({job,runId:'r1',traceId:'t1',tool:'publish_content',auth,decision,context,env:{}});
  for(const key of ['what','where','why','objective','channel','account_ref','content_or_offer','risk','cost','approval','expected_result']) assert.ok(Object.hasOwn(plan,key),key);
  assert.equal(plan.state,'planned');assert.equal(plan.approval.required,true);assert.equal(plan.channel,'instagram');
  const serialized=JSON.stringify(plan);assert.doesNotMatch(serialized,/SECRET_CONTACT|SECRET_SESSION/);
  assert.match(plan.content_or_offer.sha256,/^[a-f0-9]{64}$/);
});

test('same manifest id survives a resumed approval run',()=>{
  const first=buildLiveActionPlan({job,runId:'r1',traceId:'t1',tool:'publish_content',auth,decision,context,env:{}});
  const resumedJob={...job,payload:{live_action_plan:{...first,approval:{required:true,status:'approved'}}}};
  const second=buildLiveActionPlan({job:resumedJob,runId:'r2',traceId:'t2',tool:'publish_content',auth,decision,context,env:{}});
  assert.equal(second.manifest_id,first.manifest_id);assert.equal(second.created_at,first.created_at);assert.equal(second.approval.status,'approved');
});

test('persistence and transitions update the same plan record',async()=>{
  let stored=null;const sql={query:async(q,args)=>{
    if(String(q).includes('coalesce(payload')){stored=JSON.parse(args[1]);return [{live_action_plan:stored}];}
    const patch=JSON.parse(args[1]);stored={...stored,...patch};return [{live_action_plan:stored}];
  }};
  const plan=buildLiveActionPlan({job,runId:'r1',traceId:'t1',tool:'send_message',auth,decision:{...decision,action:'send_message'},context,env:{}});
  await persistLiveActionPlan(sql,job.job_id,plan);
  const done=await transitionLiveActionPlan(sql,job.job_id,{state:'executed',result:{status:'pending'},evidence:{event_id:'e1'},approvalStatus:'consumed'});
  assert.equal(done.manifest_id,plan.manifest_id);assert.equal(done.state,'executed');assert.equal(done.approval.required,true);assert.equal(done.approval.status,'consumed');
  assert.equal(summarizeLiveActionPlan(done).evidence.event_id,'e1');
});

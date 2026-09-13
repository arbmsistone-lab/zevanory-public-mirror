import test from 'node:test';
import assert from 'node:assert/strict';
import { SERVICE_OBJECTIVES, assessServiceLevel, assessOutboxHealth, assessAgentHealth } from '../src/enterpriseAssurance.mjs';
import { validateProviderContracts } from '../src/providerContracts.mjs';

test('service objectives are explicit but not falsely proven',()=>{
  const r=assessServiceLevel([{status:200,duration_ms:120},{status:200,duration_ms:300},{status:503,duration_ms:900}]);
  assert.equal(r.evidence_samples,3);
  assert.equal(r.historical_slo_proven,false);
  assert.equal(r.objectives.availability_ratio,SERVICE_OBJECTIVES.availability_ratio);
  assert.equal(r.p95_latency_ms,900);
});

test('outbox health fails on dead letter or stale backlog',()=>{
  assert.equal(assessOutboxHealth({pending:1,deadLetter:0,oldestPendingSeconds:30}).healthy,true);
  assert.equal(assessOutboxHealth({deadLetter:1}).healthy,false);
  assert.equal(assessOutboxHealth({pending:1,oldestPendingSeconds:301}).healthy,false);
});

test('agent health uses evidence ratio without inventing quality',()=>{
  assert.equal(assessAgentHealth({runs:100,failed:1}).healthy,true);
  assert.equal(assessAgentHealth({runs:10,failed:1}).healthy,false);
});

test('provider contracts preserve core boundaries',()=>{
  assert.deepEqual(validateProviderContracts(),{valid:true,errors:[]});
});

import { decideRevenueAction } from '../src/revenueAgent.mjs';
import { dispatchOutboxOnce } from '../src/integrationOutbox.mjs';
test('AI provider outage degrades to deterministic policy',async()=>{
  const previousFetch=globalThis.fetch; const previousEnabled=process.env.AGENT_AI_ENABLED;
  globalThis.fetch=async()=>({ok:false,status:503}); process.env.AGENT_AI_ENABLED='true';
  try{
    const r=await decideRevenueAction({job_type:'lead_review',lead:{stage:'new',touchpoints:0},knowledge:''},{apiKey:'test-key',model:'test-model'});
    assert.equal(r.provider,'deterministic'); assert.equal(r.mode,'deterministic'); assert.equal(r.fallback_reason,'ai_mesh_free_redundancy_below_10');
    assert.equal(r.configured_independent_domains,1); assert.equal(r.minimum_independent_domains,10);
  }finally{globalThis.fetch=previousFetch; if(previousEnabled===undefined) delete process.env.AGENT_AI_ENABLED; else process.env.AGENT_AI_ENABLED=previousEnabled;}
});

test('missing outbox adapter preserves operation for universal retry',async()=>{
  const calls=[]; const sql={query:async(q,args)=>{calls.push({q,args}); if(q.includes('returning *')) return [{event_id:'evt-1',destination:'missing',payload:{},headers:{},attempts:1}]; return [];}};
  const r=await dispatchOutboxOnce(sql,{});
  assert.equal(r.status,'retry'); assert.equal(r.ok,false); assert.equal(r.preserved,true);
  assert.equal(calls.some(x=>x.q.includes("status='retry'")),true);
});

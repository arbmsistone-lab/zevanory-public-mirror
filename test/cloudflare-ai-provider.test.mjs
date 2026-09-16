import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCloudflareAiExecutionProvider,CLOUDFLARE_AI_MODEL,CLOUDFLARE_AI_POLICY} from '../src/cloudflareAiProvider.mjs';

function fakeSql({count=0}={}){
  let used=count;
  return {async query(q,args=[]){
    const s=String(q);
    if(s.includes("select memory_value from agent_memory"))return [{memory_value:{day:new Date().toISOString().slice(0,10),count:used}}];
    if(s.includes('insert into agent_memory')){const limit=Number(args[2]);if(used>=limit)return [];used+=1;return [{memory_value:{day:args[1],count:used}}];}
    return [];
  }};
}

test('Cloudflare AI policy is free-only and bounded',()=>{
  assert.equal(CLOUDFLARE_AI_POLICY.free_only,true);
  assert.ok(CLOUDFLARE_AI_POLICY.default_daily_call_limit<=20);
  assert.equal(CLOUDFLARE_AI_MODEL,'@cf/meta/llama-3.2-1b-instruct');
});
test('provider requires real edge binding and free-only gate',()=>{
  globalThis.__ZEVANORY_EDGE_AI__={AI:{run:async()=>({response:'{}'})}};
  assert.equal(buildCloudflareAiExecutionProvider({sql:fakeSql(),env:{}}),null);
  const p=buildCloudflareAiExecutionProvider({sql:fakeSql(),env:{CLOUDFLARE_AI_FREE_ONLY:'true'}});
  assert.ok(p);assert.equal(p.cost,0);assert.equal(p.independence_domain,'cloudflare-workers-ai');
});

test('provider returns strict parsed decision from Workers AI',async()=>{
  globalThis.__ZEVANORY_EDGE_AI__={AI:{run:async(model,input)=>{assert.equal(model,CLOUDFLARE_AI_MODEL);assert.ok(input.max_tokens<=384);return {response:'{"action":"review","rationale":"evidence missing","confidence":0.9}'}}}};
  const p=buildCloudflareAiExecutionProvider({sql:fakeSql(),env:{CLOUDFLARE_AI_FREE_ONLY:'true',CLOUDFLARE_AI_DAILY_CALL_LIMIT:'20'}});
  const r=await p.execute({input:{stage:'new'},systemInstruction:'Use facts only.'});
  assert.equal(r.provider,'cloudflare');assert.equal(r.action,'review');assert.equal(r.free_only,true);
});

test('daily free budget fails closed',async()=>{
  globalThis.__ZEVANORY_EDGE_AI__={AI:{run:async()=>({response:'{"action":"review","rationale":"x","confidence":1}'})}};
  const p=buildCloudflareAiExecutionProvider({sql:fakeSql({count:20}),env:{CLOUDFLARE_AI_FREE_ONLY:'true',CLOUDFLARE_AI_DAILY_CALL_LIMIT:'20'}});
  const h=await p.health();assert.equal(h.state,'quota_limited');
  await assert.rejects(()=>p.execute({input:{},systemInstruction:''}),/free_budget_exhausted/);
});

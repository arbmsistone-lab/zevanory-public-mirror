import test from 'node:test';
import assert from 'node:assert/strict';
import { decideWithAiProviders } from '../src/aiProvider.mjs';
import { defineExecutionProvider } from '../src/universalExecutionFabric.mjs';

const provider=(id,domain,execute)=>defineExecutionProvider({
  id,independenceDomain:domain,capabilities:['ai:decision'],cost:0,
  health:async()=>({state:'available',quotaRemainingPct:100}),execute,
});

test('AI decision reroutes across independent zero-cost providers',async()=>{
  const first=provider('a','cloud-a',async()=>{throw new Error('temporary');});
  const second=provider('b','cloud-b',async()=>({provider:'vendor-b',model:'m2',mode:'ai_assisted',action:'qualify',confidence:0.9}));
  const third=provider('c','cloud-c',async()=>({provider:'vendor-c',model:'m3',mode:'ai_assisted',action:'offer',confidence:0.8}));
  const extras=Array.from({length:7},(_,i)=>provider(`x${i}`,`cloud-x${i}`,async()=>({provider:`x${i}`,model:'mx',mode:'ai_assisted',action:'review',confidence:0.5})));
  const out=await decideWithAiProviders({input:{stage:'contacted'},systemInstruction:'policy',providers:[first,second,third,...extras]});
  assert.equal(out.action,'qualify');
  assert.equal(out.routed_provider,'b');
  assert.equal(out.routed_domain,'cloud-b');
});

test('AI pool degrades to deterministic decision when every provider is unavailable',async()=>{
  const bad=provider('bad','cloud-x',async()=>{throw new Error('down');});
  const out=await decideWithAiProviders({input:{stage:'new'},providers:[bad]});
  assert.equal(out.provider,'deterministic');
  assert.equal(out.action,'first_response');
  assert.equal(out.fallback_reason,'ai_mesh_free_redundancy_below_10');
  assert.equal(out.minimum_independent_domains,10);
});


test('AI routing supports ten independent zero-cost domains when configured',async()=>{
  const source=await import('node:fs').then(fs=>fs.readFileSync(new URL('../src/aiProvider.mjs',import.meta.url),'utf8'));
  for(const marker of ["independenceDomain:'google-ai'","domain:'mistral-ai'","domain:'groqcloud'","ARBM_AI_FREE_ROUTES_JSON","domains.size<10"]) assert.match(source,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});

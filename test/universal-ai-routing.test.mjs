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
  const out=await decideWithAiProviders({input:{stage:'contacted'},systemInstruction:'policy',providers:[first,second]});
  assert.equal(out.action,'qualify');
  assert.equal(out.routed_provider,'b');
  assert.equal(out.routed_domain,'cloud-b');
});

test('AI pool degrades to deterministic decision when every provider is unavailable',async()=>{
  const bad=provider('bad','cloud-x',async()=>{throw new Error('down');});
  const out=await decideWithAiProviders({input:{stage:'new'},providers:[bad]});
  assert.equal(out.provider,'deterministic');
  assert.equal(out.action,'first_response');
  assert.equal(out.fallback_reason,'all_qualified_providers_failed');
});

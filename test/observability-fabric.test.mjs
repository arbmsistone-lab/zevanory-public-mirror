import test from 'node:test';
import assert from 'node:assert/strict';
import { defineObservabilitySink, emitObservabilityCopies, observabilitySinksFromEnv } from '../src/observabilityFabric.mjs';

const record={event:'x',request_id:'req-12345678',status:200};

test('observability quorum counts independent domains only',async()=>{
  const make=(id,domain)=>defineObservabilitySink({id,independenceDomain:domain,emit:async()=>({accepted:true})});
  const one=await emitObservabilityCopies(record,[make('a','same'),make('b','same')],{requiredCopies:2});
  assert.equal(one.durable,false);assert.equal(one.independent_domains,1);
  const two=await emitObservabilityCopies(record,[make('a','one'),make('b','two')],{requiredCopies:2});
  assert.equal(two.durable,true);assert.equal(two.independent_domains,2);
});

test('failed observability sink never prevents another independent sink',async()=>{
  const bad=defineObservabilitySink({id:'bad',independenceDomain:'bad',emit:async()=>{throw new Error('down');}});
  const good=defineObservabilitySink({id:'good',independenceDomain:'good',emit:async()=>({accepted:true})});
  const out=await emitObservabilityCopies(record,[bad,good],{requiredCopies:1});
  assert.equal(out.durable,true);assert.equal(out.copies,1);assert.equal(out.failed.length,1);
});
test('observability env registry is generic and provider-neutral',()=>{
  const env={OBSERVABILITY_SINKS_JSON:JSON.stringify([
    {id:'sink-a',endpoint:'https://a.example/ingest',token:'token-a',independence_domain:'a.example'},
    {id:'sink-b',endpoint:'https://b.example/ingest',token:'token-b',independence_domain:'b.example'},
  ])};
  const sinks=observabilitySinksFromEnv(env,{fetchImpl:async()=>({ok:true})});
  assert.equal(sinks.length,2);
  assert.equal(sinks[0].capabilities.includes('observability:log'),true);
  assert.notEqual(sinks[0].independence_domain,sinks[1].independence_domain);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defineExecutionProvider, rankExecutionProviders, executeUniversally,
  evaluateEvidenceQuorum, nextCircuitState, UNIVERSAL_EXECUTION_RULES,
} from '../src/universalExecutionFabric.mjs';

const provider=(id,{caps=['remote','linux'],fail=false,cost=0,domain=id,health={state:'available',quotaRemainingPct:100},priority=0}={})=>
  defineExecutionProvider({id,capabilities:caps,cost,independenceDomain:domain,priority,health:async()=>health,execute:async(op)=>{if(fail)throw new Error(`${id}_down`);return {id,op};}});

test('capability scheduler has no mandatory provider name',async()=>{
  const ranked=await rankExecutionProviders([
    provider('alpha'),provider('beta',{priority:5}),provider('paid',{cost:1}),
  ],{capabilities:['remote','linux'],zeroCost:true});
  assert.deepEqual(ranked.map(x=>x.provider.id),['beta','alpha']);
  assert.equal(UNIVERSAL_EXECUTION_RULES.provider_named_gate_forbidden,true);
});

test('failure reroutes to another independent provider without losing operation',async()=>{
  const operation={operation_id:'op-1',payload_hash:'abc'};
  const result=await executeUniversally({operation,providers:[provider('a',{fail:true,priority:10}),provider('b')]});
  assert.equal(result.ok,true); assert.equal(result.provider,'b');
  assert.deepEqual(result.attempts.map(x=>x.status),['failed','executed']);
});
test('all providers unavailable preserves operation for later retry',async()=>{
  const result=await executeUniversally({operation:{operation_id:'op-2'},providers:[
    provider('a',{health:{state:'unavailable'}}),provider('b',{health:{state:'unavailable'}}),
  ]});
  assert.equal(result.ok,false); assert.equal(result.preserved,true);
  assert.equal(result.reason,'no_qualified_provider_available');
});

test('evidence quorum requires independent domains and identical artifact/operation hashes',()=>{
  const base={status:'pass',artifact_sha:'artifact',operation_sha:'operation'};
  assert.equal(evaluateEvidenceQuorum([{...base,provider:'a',independence_domain:'x'},{...base,provider:'b',independence_domain:'y'}]).pass,true);
  assert.equal(evaluateEvidenceQuorum([{...base,provider:'a',independence_domain:'x'},{...base,provider:'b',independence_domain:'x'}]).pass,false);
  assert.equal(evaluateEvidenceQuorum([{...base,provider:'a',independence_domain:'x'},{...base,artifact_sha:'other',provider:'b',independence_domain:'y'}]).pass,false);
});

test('circuit breaker opens after repeated provider failures and recovers on success',()=>{
  let state={}; state=nextCircuitState(state,{threshold:2,now:1000,coolDownMs:5000});
  assert.equal(state.state,'degraded');
  state=nextCircuitState(state,{threshold:2,now:2000,coolDownMs:5000});
  assert.equal(state.state,'unavailable'); assert.equal(state.openUntil,7000);
  state=nextCircuitState(state,{success:true}); assert.equal(state.state,'available'); assert.equal(state.failures,0);
});

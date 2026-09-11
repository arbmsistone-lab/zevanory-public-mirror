import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutboundAdapters } from '../src/outboundAdapters.mjs';
import { publishViaBuffer } from '../src/bufferSocial.mjs';
import { defineChannelProvider } from '../src/channelProviderRegistry.mjs';
import { classifyDeliveryFailure, destinationAllowsAutomaticReplay, requestProviderJson } from '../src/providerDelivery.mjs';

const bufferEnv={BUFFER_API_KEY:'test-only',BUFFER_TIKTOK_CHANNEL_ID:'tt',BUFFER_LINKEDIN_CHANNEL_ID:'li'};
const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});

for(const channel of ['tiktok','linkedin','nuvemshop']){
  test(`${channel}: closed global gates prevent direct, alternate and external execution`,async()=>{
    let calls=0;
    const external=defineChannelProvider({id:'independent-test',channel,priority:1000,execute:async()=>{calls++;return {accepted:true};}});
    const adapters=buildOutboundAdapters({env:{...bufferEnv,SALE_GLOBALLY_ENABLED:'false',PRE_SALE_GATES_APPROVED:'false'},channelProviders:{[channel]:[external]},fetchImpl:async()=>{calls++;throw new Error('must_not_execute');}});
    await assert.rejects(adapters[`channel:${channel}`]({payload:{content:'test only',media_url:'https://example.org/test.mp4'}},{sql:{query:async()=>{calls++;return [];}}}),/commercial_gates_closed/);
    assert.equal(calls,0);
  });
}

test('authorized LinkedIn action can use an independent provider after conclusive local failure',async()=>{
  let effects=0;
  const adapters=buildOutboundAdapters({env:bufferEnv,commercialGate:()=>({enabled:true}),fetchImpl:async()=>{effects++;return response({data:{createPost:{post:{id:'provider-1',status:'scheduled'}}}});}});
  const result=await adapters['channel:linkedin']({payload:{content:'fixture'}},{sql:{query:async()=>[]}});
  assert.equal(result.provider,'buffer');assert.equal(effects,1);
});

for(const body of [{},{data:{createPost:{post:{id:'created'}}}},{errors:[{message:'secret-do-not-log'}]}]){
  test('ambiguous Buffer success is never invented or rerouted',async()=>{
    await assert.rejects(publishViaBuffer({channel:'linkedin',event:{payload:{content:'fixture'}},env:bufferEnv,fetchImpl:async()=>response(body)}),error=>error.ambiguous===true&&error.retryable===false&&error.message==='buffer_acceptance_uncertain');
  });
}

test('Buffer fetch is bounded and an outage is uncertain',async()=>{
  await assert.rejects(publishViaBuffer({channel:'linkedin',event:{payload:{content:'fixture'}},env:bufferEnv,fetchImpl:async(_url,options)=>{assert.ok(options.signal instanceof AbortSignal);throw new Error('credential-in-provider-message');}}),error=>error.ambiguous===true&&!error.retryable&&!error.message.includes('credential'));
});

test('Nuvemshop product creation without proven provider idempotency never auto-replays',async()=>{
  assert.equal(destinationAllowsAutomaticReplay('channel:nuvemshop'),false);
  assert.equal(classifyDeliveryFailure(new Error('uncertain'),'channel:nuvemshop').status,'dead_letter');
  await assert.rejects(requestProviderJson(async()=>{throw new Error('network');},'https://api.nuvemshop.com/v1/1/products',{method:'POST',headers:{'content-type':'application/json'}}),error=>error.ambiguous===true&&error.retryable===false);
});

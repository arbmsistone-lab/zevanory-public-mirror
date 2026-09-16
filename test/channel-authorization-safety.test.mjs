import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutboundAdapters } from '../src/outboundAdapters.mjs';
import { publishViaBuffer } from '../src/bufferSocial.mjs';
import { defineChannelProvider } from '../src/channelProviderRegistry.mjs';
import { classifyDeliveryFailure, destinationAllowsAutomaticReplay, requestProviderJson } from '../src/providerDelivery.mjs';

const bufferEnv={BUFFER_API_KEY:'test-only',BUFFER_TIKTOK_CHANNEL_ID:'tt',BUFFER_LINKEDIN_CHANNEL_ID:'li'};
const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});

test('TikTok LinkedIn and Nuvemshop remain fail closed when provider evidence is inconclusive',async()=>{
  const adapters=buildOutboundAdapters({env:bufferEnv,commercialGate:()=>({enabled:true}),fetchImpl:async()=>response({})});
  for(const channel of ['tiktok','linkedin','nuvemshop']) await assert.rejects(()=>adapters[`channel:${channel}`]({payload:{content:'x',media_url:'https://example.org/x.mp4'}},{sql:{query:async()=>[]}}));
});


for(const body of [{},{data:{createPost:{post:{id:'created'}}}},{errors:[{message:'secret-do-not-log'}]}]){
  test('ambiguous Buffer success is never invented or rerouted',async()=>{
    await assert.rejects(publishViaBuffer({channel:'linkedin',event:{payload:{content:'fixture'}},env:bufferEnv,fetchImpl:async()=>response(body)}),error=>error.ambiguous===true&&error.retryable===false&&error.message==='buffer_acceptance_uncertain');
  });
}
test('Buffer fetch is bounded and an outage is uncertain',async()=>{
  await assert.rejects(publishViaBuffer({channel:'linkedin',event:{payload:{content:'fixture'}},env:bufferEnv,fetchImpl:async(_url,options)=>{assert.ok(options.signal instanceof AbortSignal);throw new Error('credential-in-provider-message');}}),error=>error.ambiguous===true&&!error.retryable&&!error.message.includes('credential'));
});

test('Nuvemshop provider operation remains non-replayable in backlog code',async()=>{
  assert.equal(destinationAllowsAutomaticReplay('channel:nuvemshop'),false);
  assert.equal(classifyDeliveryFailure(new Error('uncertain'),'channel:nuvemshop').status,'dead_letter');
  await assert.rejects(requestProviderJson(async()=>{throw new Error('network');},'https://api.nuvemshop.com/v1/1/products',{method:'POST',headers:{'content-type':'application/json'}}),error=>error.ambiguous===true&&error.retryable===false);
});

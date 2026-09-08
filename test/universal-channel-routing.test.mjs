import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutboundAdapters } from '../src/outboundAdapters.mjs';
import { defineChannelProvider } from '../src/channelProviderRegistry.mjs';
import { ProviderDeliveryError } from '../src/providerDelivery.mjs';
import { assertChannelActionAllowed } from '../src/channelAdapters.mjs';

const gate=()=>({enabled:true});
const externalEmail=defineChannelProvider({
  id:'mail-alt',channel:'email',independenceDomain:'mail-alt.example',
  execute:async({event})=>({provider:'mail-alt',accepted:true,provider_message_id:event.event_id||'alt-1'}),
});

test('known channel can be queued even when nominal provider is not configured',()=>{
  const state=assertChannelActionAllowed('email',{},gate);
  assert.equal(state.allowed,true);assert.equal(state.configured,false);
});

test('channel fabric reroutes from unavailable built-in to independent provider',async()=>{
  const adapters=buildOutboundAdapters({env:{},commercialGate:gate,fetchImpl:async()=>{throw new Error('should_not_fetch');},channelProviders:{email:[externalEmail]}});
  const result=await adapters['channel:email']({event_id:'evt-1',payload:{contact_ref:'x@example.test',text:'hello'}});
  assert.equal(result.provider,'mail-alt');
  assert.equal(result.execution_provider,'mail-alt');
  assert.equal(result.execution_attempts.length,2);
});

test('ambiguous external effect stops cross-provider failover for reconciliation',async()=>{
  const fallback=defineChannelProvider({id:'wa-alt',channel:'whatsapp',independenceDomain:'wa-alt.example',execute:async()=>({provider:'wa-alt',accepted:true})});
  const env={WHATSAPP_SALES_ENABLED:'true',WHATSAPP_ACCESS_TOKEN:'token',WHATSAPP_PHONE_NUMBER_ID:'phone',META_GRAPH_VERSION:'v99'};
  const adapters=buildOutboundAdapters({env,commercialGate:gate,fetchImpl:async()=>{throw new ProviderDeliveryError('network_uncertain',{ambiguous:true,retryable:false});},channelProviders:{whatsapp:[fallback]}});
  await assert.rejects(()=>adapters['channel:whatsapp']({event_id:'evt-wa',payload:{contact_ref:'5588999999999',text:'hello'}}),error=>{
    assert.equal(error.routed?.reconciliation_required,true);
    assert.equal(error.routed?.attempts?.length,1);
    return true;
  });
});

test('any channel accepts future provider adapters without core changes',async()=>{
  const provider=defineChannelProvider({id:'future-youtube',channel:'youtube',independenceDomain:'future.example',execute:async()=>({provider:'future-youtube',accepted:true,provider_post_id:'y1'})});
  const adapters=buildOutboundAdapters({env:{},commercialGate:gate,fetchImpl:async()=>{throw new Error('no built in');},channelProviders:{youtube:[provider]}});
  const result=await adapters['channel:youtube']({event_id:'evt-y',payload:{content:'demo'}});
  assert.equal(result.execution_provider,'future-youtube');
});

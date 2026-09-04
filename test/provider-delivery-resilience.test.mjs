import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOutboundAdapters} from '../src/outboundAdapters.mjs';
import {dispatchChannelOutboxOnce} from '../src/integrationOutbox.mjs';

const gate=()=>({enabled:true});
const envBase={SALE_GLOBALLY_ENABLED:'true',PRE_SALE_GATES_APPROVED:'true',META_GRAPH_VERSION:'v21.0'};

function outboxSql(event){
  const calls=[];
  return {
    calls,
    query:async(q,args=[])=>{
      calls.push({q:String(q),args});
      if(String(q).includes('returning *')) return [event];
      return [];
    },
  };
}

test('ambiguous WhatsApp transport is dead-lettered without blind replay',async()=>{
  const env={...envBase,WHATSAPP_SALES_ENABLED:'true',WHATSAPP_ACCESS_TOKEN:'x',WHATSAPP_PHONE_NUMBER_ID:'12345'};
  const adapters=buildOutboundAdapters({env,commercialGate:gate,fetchImpl:async()=>{throw new TypeError('network');}});
  const sql=outboxSql({event_id:'e1',destination:'channel:whatsapp',payload:{contact_ref:'5588999999999',text:'Oi'},headers:{},attempts:1});
  const result=await dispatchChannelOutboxOnce(sql,adapters);
  assert.equal(result.status,'dead_letter');
  assert.equal(result.retry_in_ms,null);
  assert.equal(result.reason,'provider_delivery_uncertain_manual_reconciliation');
});
test('idempotent Resend transport remains safely retryable',async()=>{
  const env={...envBase,RESEND_API_KEY:'re_test',RESEND_FROM_ADDRESS:'ZEVANORY <contato@zevanory.api.br>'};
  const adapters=buildOutboundAdapters({env,commercialGate:gate,fetchImpl:async()=>{throw new TypeError('network');}});
  const sql=outboxSql({event_id:'e2',idempotency_key:'idem-email-2',destination:'channel:email',payload:{contact_ref:'x@example.com',text:'Oi'},headers:{},attempts:1});
  const result=await dispatchChannelOutboxOnce(sql,adapters);
  assert.equal(result.status,'retry');
  assert.ok(result.retry_in_ms>0);
});

test('conclusive provider 400 goes directly to dead-letter',async()=>{
  const env={...envBase,RESEND_API_KEY:'re_test',RESEND_FROM_ADDRESS:'ZEVANORY <contato@zevanory.api.br>'};
  const adapters=buildOutboundAdapters({env,commercialGate:gate,fetchImpl:async()=>({status:400,json:async()=>({error:'bad'})})});
  const sql=outboxSql({event_id:'e3',idempotency_key:'idem-email-3',destination:'channel:email',payload:{contact_ref:'x@example.com',text:'Oi'},headers:{},attempts:1});
  const result=await dispatchChannelOutboxOnce(sql,adapters);
  assert.equal(result.status,'dead_letter');
  assert.equal(result.reason,'provider_http_400');
});

test('success response without provider id is uncertain and never auto-replayed',async()=>{
  const env={...envBase,WHATSAPP_SALES_ENABLED:'true',WHATSAPP_ACCESS_TOKEN:'x',WHATSAPP_PHONE_NUMBER_ID:'12345'};
  const adapters=buildOutboundAdapters({env,commercialGate:gate,fetchImpl:async()=>({status:200,json:async()=>({})})});
  const sql=outboxSql({event_id:'e4',destination:'channel:whatsapp',payload:{contact_ref:'5588999999999',text:'Oi'},headers:{},attempts:1});
  const result=await dispatchChannelOutboxOnce(sql,adapters);
  assert.equal(result.status,'dead_letter');
  assert.equal(result.reason,'provider_delivery_uncertain_manual_reconciliation');
});

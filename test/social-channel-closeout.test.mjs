import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOutboundAdapters} from '../src/outboundAdapters.mjs';
const base={SALE_GLOBALLY_ENABLED:'true',PRE_SALE_GATES_APPROVED:'true'};
const response=(status,body={},headers={})=>({status,ok:status>=200&&status<300,json:async()=>body,arrayBuffer:async()=>Buffer.isBuffer(body)?body:Buffer.from(typeof body==='string'?body:JSON.stringify(body)),headers:{get:k=>headers[String(k).toLowerCase()]||null}});
const certifiedGate=()=>({enabled:true});

test('TikTok runtime is excluded from active commercial scope',async()=>{
  const a=buildOutboundAdapters({env:base,commercialGate:certifiedGate,fetchImpl:async()=>response(200,{})});
  await assert.rejects(()=>a['channel:tiktok']({payload:{content:'x',media_url:'https://cdn.example/x.mp4'}},{sql:{query:async()=>[]}}),/channel_excluded_from_active_scope/);
});

test('affiliate adapter is generic, HTTPS-only and idempotent',async()=>{
  const calls=[];const env={...base,AFFILIATE_PROVIDER:'network-x',AFFILIATE_WEBHOOK_URL:'https://partner.example/events',AFFILIATE_WEBHOOK_TOKEN:'secret'};
  const a=buildOutboundAdapters({env,commercialGate:certifiedGate,fetchImpl:async(url,opt)=>{calls.push({url,opt});return response(202,{tracking_id:'trk-1'});}});
  const out=await a['channel:affiliate']({event_id:'e1',idempotency_key:'idem1',aggregate_id:'lead1',payload:{click_ref:'c1'}});
  assert.equal(out.provider_message_id,'trk-1');assert.equal(calls[0].opt.headers['idempotency-key'],'idem1');
});

test('excluded TikTok remains blocked regardless of global gate state',async()=>{
  const a=buildOutboundAdapters({env:{},commercialGate:certifiedGate,fetchImpl:async()=>response(200,{})});
  await assert.rejects(()=>a['channel:tiktok']({payload:{media_url:'https://cdn.example/video.mp4'}}),/channel_excluded_from_active_scope/);
});

test('first-party affiliate channel uses internal idempotent ledger without external webhook',async()=>{
  const env={...base,AFFILIATE_PROVIDER:'zevanory-first-party'};
  const a=buildOutboundAdapters({env,commercialGate:certifiedGate,fetchImpl:async()=>{throw new Error('external_fetch_forbidden');}});
  const out=await a['channel:affiliate']({event_id:'e-first',idempotency_key:'aff-1',aggregate_id:'lead1',payload:{click_ref:'c1'}});
  assert.equal(out.provider_message_id,'aff-1');assert.equal(out.confirmation,'first_party_ledger');
});

test('LinkedIn rich media runtime remains excluded from active scope',async()=>{
  const adapters=buildOutboundAdapters({env:base,commercialGate:certifiedGate,fetchImpl:async()=>response(200,{})});
  await assert.rejects(()=>adapters['channel:linkedin']({payload:{content:'x',media_url:'https://zevanory.api.br/creative.png'}},{sql:{query:async()=>[]}}),/channel_excluded_from_active_scope/);
});
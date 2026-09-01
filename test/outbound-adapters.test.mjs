import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOutboundAdapters} from '../src/outboundAdapters.mjs';
import {channelReadiness} from '../src/channelAdapters.mjs';
import {dispatchChannelOutboxOnce} from '../src/integrationOutbox.mjs';

const baseEnv={SALE_GLOBALLY_ENABLED:'true',PRE_SALE_GATES_APPROVED:'true',META_GRAPH_VERSION:'v-test'};
const response=(status,body)=>({status,json:async()=>body});

test('WhatsApp adapter requires channel gate and returns provider id only',async()=>{
  const calls=[];const env={...baseEnv,WHATSAPP_SALES_ENABLED:'true',WHATSAPP_ACCESS_TOKEN:'token',WHATSAPP_PHONE_NUMBER_ID:'123'};
  const adapters=buildOutboundAdapters({env,fetchImpl:async(url,options)=>{calls.push({url,options});return response(200,{messages:[{id:'wamid.1'}]});}});
  const result=await adapters['channel:whatsapp']({payload:{contact_ref:'5588999999999',text:'Oi'}});
  assert.equal(result.provider_message_id,'wamid.1');assert.equal(result.confirmation,'webhook_required');
  assert.match(calls[0].url,/\/123\/messages$/);assert.match(calls[0].options.headers.authorization,/Bearer token/);
});

test('Resend adapter sends with idempotency and does not claim delivery truth',async()=>{
  const calls=[];const env={SALE_GLOBALLY_ENABLED:'true',PRE_SALE_GATES_APPROVED:'true',RESEND_API_KEY:'re_test',RESEND_FROM_ADDRESS:'ZEVANORY <contato@zevanory.api.br>'};
  const adapters=buildOutboundAdapters({env,fetchImpl:async(url,options)=>{calls.push({url,options});return response(200,{id:'email_1'});}});
  const result=await adapters['channel:email']({event_id:'e1',idempotency_key:'idem-1',payload:{contact_ref:'x@example.com',text:'Mensagem'}});
  assert.equal(result.provider_message_id,'email_1');assert.equal(calls[0].options.headers['idempotency-key'],'idem-1');
});
test('Instagram requires HTTPS media and publishes through container',async()=>{
  const calls=[];const env={...baseEnv,META_ACCESS_TOKEN:'meta',INSTAGRAM_BUSINESS_ACCOUNT_ID:'ig1'};
  const adapters=buildOutboundAdapters({env,fetchImpl:async(url,options)=>{calls.push({url,options});return calls.length===1?response(200,{id:'container1'}):response(200,{id:'media1'});}});
  const result=await adapters['channel:instagram']({payload:{content:'Legenda',media_url:'https://cdn.example.com/a.jpg'}});
  assert.equal(result.provider_media_id,'media1');assert.equal(result.container_id,'container1');assert.equal(calls.length,2);
  await assert.rejects(()=>adapters['channel:instagram']({payload:{content:'x',media_url:'http://unsafe.test/x.jpg'}}),/instagram_media_url_required/);
});

test('YouTube is not publish-ready with API key or OAuth token until upload pipeline exists',()=>{
  const apiKeyOnly=channelReadiness({YOUTUBE_API_KEY:'key'}).youtube;
  const oauth=channelReadiness({YOUTUBE_OAUTH_ACCESS_TOKEN:'oauth'}).youtube;
  assert.equal(apiKeyOnly.configured,false);assert.equal(oauth.configured,false);assert.equal(oauth.implemented,false);
});

test('channel dispatcher cannot claim payment destinations',async()=>{
  const queries=[];const sql={query:async(q,args=[])=>{queries.push(String(q));if(String(q).includes('returning *'))return [];return [];}};
  const result=await dispatchChannelOutboxOnce(sql,{});
  assert.equal(result.processed,false);assert.match(queries[0],/destination like 'channel:%'/);
});

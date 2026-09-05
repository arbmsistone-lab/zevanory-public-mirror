import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOutboundAdapters} from '../src/outboundAdapters.mjs';
import {channelReadiness} from '../src/channelAdapters.mjs';
import {encryptTikTokSecret} from '../src/tiktokOAuth.mjs';
import {encryptCommercialSecret} from '../src/commercialOAuthCrypto.mjs';
const base={SALE_GLOBALLY_ENABLED:'true',PRE_SALE_GATES_APPROVED:'true'};
const response=(status,body={},headers={})=>({status,json:async()=>body,headers:{get:k=>headers[String(k).toLowerCase()]||null}});
const certifiedGate=()=>({enabled:true});
const tiktokKey=Buffer.alloc(32,7).toString('base64');
const tiktokSql=(env)=>({query:async()=>[{account_id:'open-1',access_token_enc:encryptTikTokSecret('t',env),refresh_token_enc:encryptTikTokSecret('r',env),token_type:'Bearer',scope:'user.info.basic,video.publish',expires_at:new Date(Date.now()+3600000)}]});

test('TikTok remains fail closed without verified content source and user consent',async()=>{
  const ready=channelReadiness({TIKTOK_CLIENT_KEY:'k',TIKTOK_CLIENT_SECRET:'s',TIKTOK_TOKEN_ENCRYPTION_KEY:tiktokKey,TIKTOK_EXPECTED_USERNAME:'zevanory',TIKTOK_CONTENT_SOURCE_VERIFIED:'true',TIKTOK_IDENTITY_VERIFIED:'true',TIKTOK_CLIENT_AUDITED:'true'}).tiktok;
  assert.equal(ready.implemented,true);assert.equal(ready.configured,true);
  const env={...base,TIKTOK_TOKEN_ENCRYPTION_KEY:tiktokKey,TIKTOK_CONTENT_SOURCE_VERIFIED:'false'};
  const a=buildOutboundAdapters({env,commercialGate:certifiedGate,fetchImpl:async()=>response(200,{})});
  await assert.rejects(()=>a['channel:tiktok']({payload:{user_consent:true,media_url:'https://cdn.example/video.mp4'}},{sql:tiktokSql(env)}),/tiktok_content_source_unverified/);
});

test('TikTok queries creator and forces SELF_ONLY for unaudited client',async()=>{
  const calls=[];const env={...base,TIKTOK_TOKEN_ENCRYPTION_KEY:tiktokKey,TIKTOK_CONTENT_SOURCE_VERIFIED:'true',TIKTOK_CLIENT_AUDITED:'false'};
  const a=buildOutboundAdapters({env,commercialGate:certifiedGate,fetchImpl:async(url,opt)=>{calls.push({url,opt});return calls.length===1?response(200,{data:{privacy_level_options:['SELF_ONLY','PUBLIC_TO_EVERYONE']},error:{code:'ok'}}):response(200,{data:{publish_id:'pub-1'},error:{code:'ok'}});}});
  const out=await a['channel:tiktok']({payload:{user_consent:true,content:'Demo',privacy_level:'PUBLIC_TO_EVERYONE',media_url:'https://cdn.example/video.mp4'}},{sql:tiktokSql(env)});
  assert.equal(out.provider_post_id,'pub-1');assert.equal(out.privacy_level,'SELF_ONLY');assert.match(calls[0].url,/creator_info\/query/);assert.match(calls[1].url,/video\/init/);
});
test('LinkedIn posts through official REST Posts API and requires provider id',async()=>{
  const calls=[];const env={...base,COMMERCIAL_OAUTH_ENCRYPTION_KEY:Buffer.alloc(32,5).toString('base64'),LINKEDIN_VERSION:'202608'};
  const sql={query:async()=>[{account_id:'person123',access_token_enc:encryptCommercialSecret('li',env),scope:'w_member_social',expires_at:new Date(Date.now()+3600000)}]};
  const a=buildOutboundAdapters({env,commercialGate:certifiedGate,fetchImpl:async(url,opt)=>{calls.push({url,opt});return response(201,{}, {'x-restli-id':'urn:li:share:1'});}});
  const out=await a['channel:linkedin']({payload:{content:'Atualizacao ZEVANORY'}},{sql});
  assert.equal(out.provider_post_id,'urn:li:share:1');assert.equal(calls[0].url,'https://api.linkedin.com/rest/posts');assert.equal(calls[0].opt.headers['linkedin-version'],'202608');
});

test('affiliate adapter is generic, HTTPS-only and idempotent',async()=>{
  const calls=[];const env={...base,AFFILIATE_PROVIDER:'network-x',AFFILIATE_WEBHOOK_URL:'https://partner.example/events',AFFILIATE_WEBHOOK_TOKEN:'secret'};
  const a=buildOutboundAdapters({env,commercialGate:certifiedGate,fetchImpl:async(url,opt)=>{calls.push({url,opt});return response(202,{tracking_id:'trk-1'});}});
  const out=await a['channel:affiliate']({event_id:'e1',idempotency_key:'idem1',aggregate_id:'lead1',payload:{click_ref:'c1'}});
  assert.equal(out.provider_message_id,'trk-1');assert.equal(calls[0].opt.headers['idempotency-key'],'idem1');
});

test('new commercial channels remain globally gated',async()=>{
  const a=buildOutboundAdapters({env:{TIKTOK_TOKEN_ENCRYPTION_KEY:tiktokKey,TIKTOK_CONTENT_SOURCE_VERIFIED:'true'},fetchImpl:async()=>response(200,{})});
  await assert.rejects(()=>a['channel:tiktok']({payload:{user_consent:true,media_url:'https://cdn.example/video.mp4'}}),/commercial_gates_closed/);
});

test('first-party affiliate channel uses internal idempotent ledger without external webhook',async()=>{
  const env={...base,AFFILIATE_PROVIDER:'zevanory-first-party'};
  const a=buildOutboundAdapters({env,commercialGate:certifiedGate,fetchImpl:async()=>{throw new Error('external_fetch_forbidden');}});
  const out=await a['channel:affiliate']({event_id:'e-first',idempotency_key:'aff-1',aggregate_id:'lead1',payload:{click_ref:'c1'}});
  assert.equal(out.provider_message_id,'aff-1');assert.equal(out.confirmation,'first_party_ledger');
});

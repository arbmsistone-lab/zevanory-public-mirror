import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyFacebookIdentity,verifyInstagramIdentity,verifyWhatsappIdentity,verifyYouTubeIdentity,verifyTikTokIdentity,resolveMetaVerifyToken,CANONICAL_EXTERNAL_IDENTITIES } from '../src/channelIdentityPreflight.mjs';

const response=(status,body={})=>({status,ok:status>=200&&status<300,json:async()=>body});

test('Meta verify token prefers canonical production name and keeps legacy fallback',()=>{
  assert.equal(resolveMetaVerifyToken({META_VERIFY_TOKEN:'new',META_WEBHOOK_VERIFY_TOKEN:'old'}),'new');
  assert.equal(resolveMetaVerifyToken({META_WEBHOOK_VERIFY_TOKEN:'old'}),'old');
  assert.equal(resolveMetaVerifyToken({}),'');
});

test('Facebook preflight rejects legacy page identity',async()=>{
  const env={META_ACCESS_TOKEN:'secret',META_PAGE_ID:'p1',META_GRAPH_VERSION:'v26.0'};
  const good=await verifyFacebookIdentity({env,fetchImpl:async()=>response(200,{id:'p1',name:'Zevanory'})});
  const old=await verifyFacebookIdentity({env,fetchImpl:async()=>response(200,{id:'p1',name:'Central Giro de Ofertas'})});
  assert.equal(good.verified,true);assert.equal(old.verified,false);assert.equal(JSON.stringify(good).includes('secret'),false);
});

test('Instagram preflight requires canonical zevanory underscore username',async()=>{
  const env={META_ACCESS_TOKEN:'secret',INSTAGRAM_BUSINESS_ACCOUNT_ID:'ig1',META_GRAPH_VERSION:'v26.0'};
  const good=await verifyInstagramIdentity({env,fetchImpl:async()=>response(200,{id:'ig1',username:'zevanory_',biography:'Atendimento WhatsApp +55 88 9234-0423',website:'https://zevanory.api.br'})});
  const missingContact=await verifyInstagramIdentity({env,fetchImpl:async()=>response(200,{id:'ig1',username:'zevanory_',biography:'IA e automacao',website:'https://zevanory.api.br'})});
  const wrong=await verifyInstagramIdentity({env,fetchImpl:async()=>response(200,{id:'ig1',username:'other'})});
  assert.equal(good.verified,true);assert.equal(good.whatsapp_contact_visible,true);assert.equal(missingContact.verified,true);assert.equal(missingContact.whatsapp_contact_visible,false);assert.equal(wrong.verified,false);
});

test('WhatsApp preflight binds token and phone id to canonical commercial number',async()=>{
  const env={WHATSAPP_ACCESS_TOKEN:'secret',WHATSAPP_PHONE_NUMBER_ID:'wa1',META_GRAPH_VERSION:'v26.0'};
  const good=await verifyWhatsappIdentity({env,fetchImpl:async()=>response(200,{id:'wa1',display_phone_number:'+55 88 9234-0423',verified_name:'ZEVANORY',name_status:'PENDING_REVIEW',quality_rating:'GREEN'})});
  const wrong=await verifyWhatsappIdentity({env,fetchImpl:async()=>response(200,{id:'wa1',display_phone_number:'+55 88 99999-9999'})});
  assert.equal(good.verified,true);assert.equal(good.display_phone_number,CANONICAL_EXTERNAL_IDENTITIES.whatsapp_e164);assert.equal(wrong.verified,false);
});

test('YouTube preflight requires authenticated canonical channel id',async()=>{
  const env={YOUTUBE_OAUTH_ACCESS_TOKEN:'secret'};
  const good=await verifyYouTubeIdentity({env,fetchImpl:async()=>response(200,{items:[{id:CANONICAL_EXTERNAL_IDENTITIES.youtube_channel_id,snippet:{title:'ZEVANORY'}}]})});
  const wrong=await verifyYouTubeIdentity({env,fetchImpl:async()=>response(200,{items:[{id:'UCwrong',snippet:{title:'Other'}}]})});
  assert.equal(good.verified,true);assert.equal(wrong.verified,false);assert.equal(JSON.stringify(good).includes('secret'),false);
});

test('TikTok preflight cannot verify without expected username',async()=>{
  const missing=await verifyTikTokIdentity({env:{TIKTOK_ACCESS_TOKEN:'secret'},fetchImpl:async()=>response(200)});
  assert.equal(missing.verified,false);assert.equal(missing.reason,'expected_username_missing');
  const env={TIKTOK_ACCESS_TOKEN:'secret',TIKTOK_EXPECTED_USERNAME:'@zevanory'};
  const good=await verifyTikTokIdentity({env,fetchImpl:async()=>response(200,{data:{creator_username:'zevanory',creator_nickname:'ZEVANORY'},error:{code:'ok'}})});
  assert.equal(good.verified,true);assert.equal(JSON.stringify(good).includes('secret'),false);
});

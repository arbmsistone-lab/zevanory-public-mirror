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
  const good=await verifyWhatsappIdentity({env,fetchImpl:async()=>response(200,{id:'wa1',display_phone_number:'+55 88 9234-0423',verified_name:'ZEVANORY',name_status:'AVAILABLE_WITHOUT_REVIEW',new_name_status:'APPROVED',quality_rating:'GREEN',code_verification_status:'VERIFIED'})});
  const legacy=await verifyWhatsappIdentity({env,fetchImpl:async()=>response(200,{id:'wa1',display_phone_number:'+55 88 9234-0423',verified_name:'Giro Local',name_status:'AVAILABLE_WITHOUT_REVIEW',quality_rating:'GREEN'})});
  const pending=await verifyWhatsappIdentity({env,fetchImpl:async()=>response(200,{id:'wa1',display_phone_number:'+55 88 9234-0423',verified_name:'ZEVANORY',name_status:'PENDING_REVIEW',quality_rating:'GREEN'})});
  const wrong=await verifyWhatsappIdentity({env,fetchImpl:async()=>response(200,{id:'wa1',display_phone_number:'+55 88 99999-9999',verified_name:'ZEVANORY',name_status:'APPROVED'})});
  assert.equal(good.verified,true);assert.equal(good.brand_name_verified,true);assert.equal(good.display_phone_number,CANONICAL_EXTERNAL_IDENTITIES.whatsapp_e164);assert.equal(good.new_name_status,'APPROVED');assert.equal(good.code_verification_status,'VERIFIED');assert.equal(legacy.verified,false);assert.equal(legacy.reason,'brand_display_name_mismatch');assert.equal(pending.verified,false);assert.equal(pending.reason,'brand_display_name_not_ready');assert.equal(wrong.verified,false);
});

test('YouTube preflight requires authenticated canonical channel id',async()=>{
  const env={YOUTUBE_OAUTH_ACCESS_TOKEN:'secret'};
  const good=await verifyYouTubeIdentity({env,fetchImpl:async()=>response(200,{items:[{id:CANONICAL_EXTERNAL_IDENTITIES.youtube_channel_id,snippet:{title:'ZEVANORY'}}]})});
  const wrong=await verifyYouTubeIdentity({env,fetchImpl:async()=>response(200,{items:[{id:'UCwrong',snippet:{title:'Other'}}]})});
  assert.equal(good.verified,true);assert.equal(wrong.verified,false);assert.equal(JSON.stringify(good).includes('secret'),false);
});

test('YouTube preflight verifies canonical public feed when OAuth is unavailable',async()=>{
  const xml=`<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><yt:channelId>${CANONICAL_EXTERNAL_IDENTITIES.youtube_channel_id.replace(/^UC/,'')}</yt:channelId><link rel="alternate" href="https://www.youtube.com/channel/${CANONICAL_EXTERNAL_IDENTITIES.youtube_channel_id}"/><author><name>ZEVANORY</name></author></feed>`;
  const good=await verifyYouTubeIdentity({env:{},fetchImpl:async()=>({status:200,ok:true,text:async()=>xml})});
  assert.equal(good.verified,true);assert.equal(good.reason,'identity_match_public_feed');assert.equal(good.verification_mode,'public_provider_feed');
});

test('TikTok preflight cannot verify without expected username',async()=>{
  const missing=await verifyTikTokIdentity({env:{TIKTOK_ACCESS_TOKEN:'secret'},fetchImpl:async()=>response(200)});
  assert.equal(missing.verified,false);assert.equal(missing.reason,'expected_username_missing');
  const env={TIKTOK_ACCESS_TOKEN:'secret',TIKTOK_EXPECTED_USERNAME:'@zevanory'};
  const good=await verifyTikTokIdentity({env,fetchImpl:async()=>response(200,{data:{creator_username:'zevanory',creator_nickname:'ZEVANORY'},error:{code:'ok'}})});
  assert.equal(good.verified,true);assert.equal(JSON.stringify(good).includes('secret'),false);
});


test('Instagram preflight accepts verified canonical site route to official WhatsApp',async()=>{
  const env={META_ACCESS_TOKEN:'secret',INSTAGRAM_BUSINESS_ACCOUNT_ID:'ig1',META_GRAPH_VERSION:'v26.0'};
  const fetchImpl=async(url)=>{
    const u=String(url);
    if(u.includes('graph.facebook.com'))return response(200,{id:'ig1',username:'zevanory_',biography:'Tecnologia e IA',website:'https://zevanory.api.br/arbm-sist?utm_source=instagram'});
    if(u.includes('/whatsapp-contact.js'))return {status:200,ok:true,text:async()=>"const NUMBER='558892340423'; const href='https://wa.me/'+NUMBER;"};
    if(u.startsWith('https://zevanory.api.br/'))return {status:200,ok:true,text:async()=>'<script src="/whatsapp-contact.js" defer></script>'};
    return {status:404,ok:false,text:async()=>''};
  };
  const result=await verifyInstagramIdentity({env,fetchImpl});
  assert.equal(result.verified,true);
  assert.equal(result.whatsapp_contact_visible,false);
  assert.equal(result.whatsapp_route_ready,true);
  assert.equal(result.whatsapp_route_mode,'canonical_site_script');
});

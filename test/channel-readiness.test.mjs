import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANNELS, channelReadiness, assertChannelActionAllowed } from '../src/channelAdapters.mjs';
import { CHANNEL_PROFILES, PROFESSIONAL_EMAIL } from '../src/channelProfiles.mjs';

test('multichannel catalog includes owned social search email and partner channels',()=>{
  for(const name of ['zevanory','whatsapp','email','instagram','facebook','tiktok','youtube','linkedin','google','affiliate','nuvemshop','mercado_livre']) assert.ok(CHANNELS[name]);
});

test('owned web and organic search are configured without credentials',()=>{
  const r=channelReadiness({}); assert.equal(r.zevanory.configured,true); assert.equal(r.google.configured,true);
});

test('external channels fail closed without credentials',()=>{
  const r=channelReadiness({});  for(const name of ['whatsapp','email','instagram','facebook','tiktok','youtube','linkedin','affiliate','nuvemshop','mercado_livre']) assert.equal(r[name].configured,false);
});

test('email readiness uses the canonical Resend credential',()=>{
  const missing=channelReadiness({}).email; assert.equal(missing.provider,'resend'); assert.deepEqual([...missing.missing],['RESEND_API_KEY']);
  const ready=channelReadiness({RESEND_API_KEY:'re_test'}).email; assert.equal(ready.configured,true);
});

test('commercial action remains blocked while global gates are closed',()=>{
  assert.throws(()=>assertChannelActionAllowed('zevanory',{}),/commercial_gates_closed/);
});

test('professional email uses domain and requires authentication records',()=>{
  assert.equal(PROFESSIONAL_EMAIL.primary,'contato@zevanory.api.br');
  assert.deepEqual([...PROFESSIONAL_EMAIL.requiredDns],['MX','SPF','DKIM','DMARC']);
});

test('confirmed social profiles keep canonical public URLs',()=>{
  assert.equal(CHANNEL_PROFILES.instagram.profileUrl,'https://www.instagram.com/zevanory_/');
  assert.equal(CHANNEL_PROFILES.youtube.profileUrl,'https://youtube.com/@zevanory');
  const instagramUrl=new URL(CHANNEL_PROFILES.instagram.profileUrl);
  assert.equal(instagramUrl.protocol,'https:');
  assert.equal(instagramUrl.hostname,'www.instagram.com');
  assert.equal(instagramUrl.pathname,'/zevanory_/');
  assert.equal('@'+instagramUrl.pathname.replaceAll('/',''),CHANNEL_PROFILES.instagram.handle);
});

test('institutional profiles represent ZEVANORY rather than one product',()=>{
  for(const p of Object.values(CHANNEL_PROFILES)){
    assert.ok(p.url.includes('zevanory.api.br/?utm_source='));
    assert.ok(p.url.includes('utm_campaign=zevanory_brand'));
    assert.equal(p.bio.includes('ARBM SIST'),false);
  }
});

test('external credentials alone never satisfy provider identity readiness',()=>{
  const meta={META_ACCESS_TOKEN:'m',META_PAGE_ID:'p',INSTAGRAM_BUSINESS_ACCOUNT_ID:'i',META_GRAPH_VERSION:'v26.0'};
  assert.equal(channelReadiness(meta).facebook.configured,false);
  assert.equal(channelReadiness(meta).instagram.configured,false);
  const wa={WHATSAPP_ACCESS_TOKEN:'w',WHATSAPP_PHONE_NUMBER_ID:'n',META_APP_SECRET:'a',META_VERIFY_TOKEN:'v',META_GRAPH_VERSION:'v26.0'};
  assert.equal(channelReadiness(wa).whatsapp.configured,false);
  assert.equal(channelReadiness({YOUTUBE_OAUTH_ACCESS_TOKEN:'y'}).youtube.configured,false);
});

test('verified identity flags unlock technical readiness but not commercial gates',()=>{
  const fb={META_ACCESS_TOKEN:'m',META_PAGE_ID:'p',META_GRAPH_VERSION:'v26.0',META_FACEBOOK_IDENTITY_VERIFIED:'true'};
  assert.equal(channelReadiness(fb).facebook.configured,true);assert.throws(()=>assertChannelActionAllowed('facebook',fb),/commercial_gates_closed/);
  const wa={WHATSAPP_ACCESS_TOKEN:'w',WHATSAPP_PHONE_NUMBER_ID:'n',META_APP_SECRET:'a',META_VERIFY_TOKEN:'v',META_GRAPH_VERSION:'v26.0',META_WHATSAPP_IDENTITY_VERIFIED:'true'};
  assert.equal(channelReadiness(wa).whatsapp.configured,true);assert.throws(()=>assertChannelActionAllowed('whatsapp',wa),/commercial_gates_closed/);
  assert.equal(channelReadiness({YOUTUBE_OAUTH_ACCESS_TOKEN:'y',YOUTUBE_IDENTITY_VERIFIED:'true'}).youtube.configured,true);
});

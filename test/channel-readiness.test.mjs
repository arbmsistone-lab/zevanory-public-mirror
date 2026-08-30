import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANNELS, channelReadiness, assertChannelActionAllowed } from '../src/channelAdapters.mjs';
import { CHANNEL_PROFILES, PROFESSIONAL_EMAIL } from '../src/channelProfiles.mjs';

test('multichannel catalog includes owned social search email and partner channels',()=>{
  for(const name of ['zevanory','whatsapp','email','instagram','facebook','tiktok','youtube','linkedin','google','affiliate']) assert.ok(CHANNELS[name]);
});

test('owned web and organic search are configured without credentials',()=>{
  const r=channelReadiness({}); assert.equal(r.zevanory.configured,true); assert.equal(r.google.configured,true);
});

test('external channels fail closed without credentials',()=>{
  const r=channelReadiness({});  for(const name of ['whatsapp','email','instagram','facebook','tiktok','youtube','linkedin','affiliate']) assert.equal(r[name].configured,false);
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
  assert.equal(CHANNEL_PROFILES.instagram.profileUrl,'https://instagram.com/zevanory');
  assert.equal(CHANNEL_PROFILES.youtube.profileUrl,'https://youtube.com/@zevanory');
});

test('institutional profiles represent ZEVANORY rather than one product',()=>{
  for(const p of Object.values(CHANNEL_PROFILES)){
    assert.ok(p.url.includes('zevanory.api.br/?utm_source='));
    assert.ok(p.url.includes('utm_campaign=zevanory_brand'));
    assert.equal(p.bio.includes('ARBM SIST'),false);
  }
});

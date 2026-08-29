import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANNELS, channelReadiness, assertChannelActionAllowed } from '../src/channelAdapters.mjs';
import { CHANNEL_PROFILES, PROFESSIONAL_EMAIL } from '../src/channelProfiles.mjs';

test('multichannel catalog includes owned, social, search, email and partner channels',()=>{
  for(const name of ['zevanory','whatsapp','email','instagram','facebook','tiktok','youtube','linkedin','google','affiliate']) assert.ok(CHANNELS[name]);
});

test('owned web and organic search are technically configured without credentials',()=>{
  const r=channelReadiness({}); assert.equal(r.zevanory.configured,true); assert.equal(r.google.configured,true);
});

test('external channels fail closed without credentials',()=>{
  const r=channelReadiness({}); for(const name of ['whatsapp','email','instagram','facebook','tiktok','youtube','linkedin','affiliate']) assert.equal(r[name].configured,false);
});

test('commercial action remains blocked while global gates are closed',()=>{
  assert.throws(()=>assertChannelActionAllowed('zevanory',{}),/commercial_gates_closed/);
});

test('professional email uses domain and requires authentication records',()=>{
  assert.equal(PROFESSIONAL_EMAIL.primary,'contato@zevanory.api.br');
  assert.deepEqual([...PROFESSIONAL_EMAIL.requiredDns],['MX','SPF','DKIM','DMARC']);
});

test('every public profile points to tracked ARBM SIST landing',()=>{
  for(const p of Object.values(CHANNEL_PROFILES)){ assert.match(p.url,/\/arbm-sist\?utm_source=/); assert.match(p.url,/utm_campaign=arbm_sist_launch/); }
});

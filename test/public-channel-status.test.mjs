import test from 'node:test';
import assert from 'node:assert/strict';
import { publicChannelStatus } from '../src/publicChannelStatus.mjs';

test('public channel status exposes readiness without secret inventory',()=>{
  const state=publicChannelStatus({RESEND_API_KEY:'secret-email',MERCADOPAGO_ACCESS_TOKEN:'secret-payment',TIKTOK_CONTENT_SOURCE_VERIFIED:'false'});
  assert.equal(state.zevanory.configured,true); assert.equal(state.google.configured,true); assert.equal(state.email.configured,true);
  assert.equal(state.whatsapp.configured,false); assert.equal(state.tiktok.configured,false); assert.equal(state.tiktok.api_configured,false);
  assert.equal(state.instagram.profile_url,'https://instagram.com/zevanory_'); assert.equal(state.youtube.profile_url,'https://youtube.com/@zevanory');
  const serialized=JSON.stringify(state); assert.doesNotMatch(serialized,/secret-email|secret-payment|ACCESS_TOKEN|missing/i);
});

test('configured does not bypass commercial gates',()=>{
  const state=publicChannelStatus({RESEND_API_KEY:'re_test'});
  assert.equal(state.email.configured,true); assert.equal(state.email.api_configured,true); assert.equal(state.email.commercial,true); assert.equal(state.email.role,'crm_nurture');
});

test('assisted channels expose operational truth separately from API readiness',()=>{
  const state=publicChannelStatus({TIKTOK_PROFILE_VERIFIED:'true',TIKTOK_OPERATOR_ASSISTED_PUBLISHING:'true',TIKTOK_PROFILE_URL:'https://www.tiktok.com/@zevanory3'});
  assert.equal(state.tiktok.configured,true); assert.equal(state.tiktok.operational_ready,true); assert.equal(state.tiktok.api_configured,false); assert.equal(state.tiktok.operational_mode,'operator_assisted');
});

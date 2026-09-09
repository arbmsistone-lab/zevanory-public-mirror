import test from 'node:test';
import assert from 'node:assert/strict';
import { publicChannelStatus, publicChannelReadinessSummary } from '../src/publicChannelStatus.mjs';

test('public channel status exposes readiness without secret inventory',()=>{
  const state=publicChannelStatus({RESEND_API_KEY:'secret-email',MERCADOPAGO_ACCESS_TOKEN:'secret-payment',TIKTOK_CONTENT_SOURCE_VERIFIED:'false'});
  assert.equal(state.zevanory.configured,true); assert.equal(state.google.configured,true); assert.equal(state.email.configured,true);
  assert.equal(state.whatsapp.configured,false); assert.equal(state.tiktok.configured,false); assert.equal(state.tiktok.api_configured,false);
  assert.equal(state.instagram.profile_url,'https://www.instagram.com/zevanory_/'); assert.equal(state.youtube.profile_url,'https://youtube.com/@zevanory');
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


test('summary exposes only operational booleans and no profile or secret material',()=>{
  const summary=publicChannelReadinessSummary({LINKEDIN_FOUNDER_PROFILE_VERIFIED:'true',LINKEDIN_OPERATOR_ASSISTED_PUBLISHING:'true',LINKEDIN_FOUNDER_PROFILE_URL:'https://www.linkedin.com/in/example',NUVEMSHOP_STOREFRONT_VERIFIED:'true',NUVEMSHOP_STOREFRONT_URL:'https://example.nuvemshop.com.br'});
  assert.equal(summary.linkedin.operational_ready,true); assert.equal(summary.linkedin.operational_mode,'founder_led_operator_assisted');
  assert.equal(summary.nuvemshop.operational_ready,true); assert.equal(summary.nuvemshop.operational_mode,'verified_storefront');
  const serialized=JSON.stringify(summary); assert.doesNotMatch(serialized,/linkedin.com|nuvemshop.com|ACCESS_TOKEN|CLIENT_SECRET|secret/i);
});
